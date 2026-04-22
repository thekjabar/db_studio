import { BadRequestException } from '@nestjs/common';
import { Connection, Request, TYPES } from 'tedious';
import { Dialect } from '@prisma/client';
import {
  AlterTableSpec, ColumnMeta, ColumnSpec, ConnectionCredentials, CreateTableSpec, DriverOptions,
  ErDiagram, ForeignKeySpec, FunctionMeta, IDatabaseDriver, IndexMeta, QueryResult, TableDataQuery,
  TableDataResult, TableRef, TriggerMeta,
} from './driver.interface';
import { assertCheckExpr, assertDefaultExpr, assertFkAction, assertSqlType, quoteMssql, whitelistIdent } from './quote.util';
import { toDriverHttpError } from './driver-errors';

/**
 * Minimal MSSQL driver using tedious. Opens a fresh connection per call —
 * simple and safe but not the most performant. Good enough for a dashboard
 * workload; swap for mssql npm pool if you need perf.
 */
export class MssqlDriver implements IDatabaseDriver {
  readonly dialect = Dialect.MSSQL;
  private readonly creds: ConnectionCredentials;
  private readonly timeoutMs: number;
  private readonly readOnly: boolean;

  constructor(creds: ConnectionCredentials, opts: DriverOptions = {}) {
    this.creds = creds;
    this.timeoutMs = opts.statementTimeoutMs ?? 30_000;
    this.readOnly = !!opts.readOnly;
  }

  private connect(): Promise<Connection> {
    return new Promise((resolve, reject) => {
      const conn = new Connection({
        server: this.creds.host ?? 'localhost',
        authentication: {
          type: 'default',
          options: { userName: this.creds.user ?? '', password: this.creds.password ?? '' },
        },
        options: {
          port: this.creds.port ?? 1433,
          database: this.creds.database,
          encrypt: this.creds.sslMode !== 'disable',
          trustServerCertificate: this.creds.sslMode !== 'verify-full',
          requestTimeout: this.timeoutMs,
          connectTimeout: 10_000,
          rowCollectionOnRequestCompletion: true,
        },
      });
      conn.on('connect', (err) => (err ? reject(err) : resolve(conn)));
      conn.connect();
    });
  }

  private exec(sql: string, params: { name: string; type: any; value: unknown }[] = []): Promise<{ rows: any[]; rowCount: number }> {
    return new Promise((resolve, reject) => {
      this.connect().then((conn) => {
        const rows: any[] = [];
        const req = new Request(sql, (err, rowCount) => {
          conn.close();
          if (err) return reject(toDriverHttpError(err));
          resolve({ rows, rowCount: rowCount ?? 0 });
        });
        for (const p of params) req.addParameter(p.name, p.type, p.value);
        req.on('row', (cols) => {
          const obj: any = {};
          for (const c of cols) obj[c.metadata.colName] = c.value;
          rows.push(obj);
        });
        if (this.readOnly) {
          conn.execSqlBatch(new Request('SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED', () => conn.execSql(req)));
        } else {
          conn.execSql(req);
        }
      }).catch((err) => reject(toDriverHttpError(err)));
    });
  }

  private quoteLiteral(v: string): string {
    return `'${v.replace(/'/g, "''")}'`;
  }

  private renderDefault(c: { default?: string | null; defaultIsExpression?: boolean }): string | null {
    if (c.default == null || c.default === '') return null;
    const safe = assertDefaultExpr(c.default);
    return c.defaultIsExpression ? `(${safe})` : safe;
  }

  private colDefinition(c: ColumnSpec): string {
    const parts = [quoteMssql(c.name), assertSqlType(c.type)];
    if (c.nullable === false) parts.push('NOT NULL'); else parts.push('NULL');
    if (c.primaryKey) parts.push('PRIMARY KEY');
    if (c.unique) parts.push('UNIQUE');
    const dv = this.renderDefault(c);
    if (dv != null) parts.push(`DEFAULT ${dv}`);
    if (c.check) parts.push(`CHECK (${assertCheckExpr(c.check)})`);
    return parts.join(' ');
  }

  private fkClause(spec: CreateTableSpec | AlterTableSpec, fk: ForeignKeySpec): string {
    const refs = fk.refColumns.map(quoteMssql).join(', ');
    const cols = fk.columns.map(quoteMssql).join(', ');
    const refTbl = `${quoteMssql(fk.refSchema ?? spec.schema)}.${quoteMssql(fk.refTable)}`;
    let s = `FOREIGN KEY (${cols}) REFERENCES ${refTbl} (${refs})`;
    const onDel = assertFkAction(fk.onDelete);
    const onUpd = assertFkAction(fk.onUpdate);
    if (onDel) s += ` ON DELETE ${onDel}`;
    if (onUpd) s += ` ON UPDATE ${onUpd}`;
    return s;
  }

  async testConnection() {
    try {
      const r = await this.exec('SELECT @@VERSION AS v');
      return { ok: true, version: r.rows[0]?.v };
    } catch (e) { return { ok: false, error: (e as Error).message }; }
  }

  async listSchemas(): Promise<string[]> {
    const r = await this.exec(
      `SELECT name FROM sys.schemas WHERE name NOT IN ('sys','INFORMATION_SCHEMA','guest','db_owner','db_accessadmin','db_securityadmin','db_ddladmin','db_backupoperator','db_datareader','db_datawriter','db_denydatareader','db_denydatawriter') ORDER BY name`);
    return r.rows.map((x) => x.name);
  }

  async listTables(schema?: string): Promise<TableRef[]> {
    const where = schema ? `WHERE s.name = @schema` : '';
    const params = schema ? [{ name: 'schema', type: TYPES.NVarChar, value: schema }] : [];
    const r = await this.exec(
      `SELECT s.name AS [schema], t.name AS name, 'table' AS type
         FROM sys.tables t JOIN sys.schemas s ON t.schema_id = s.schema_id ${where}
       UNION ALL
       SELECT s.name, v.name, 'view' FROM sys.views v JOIN sys.schemas s ON v.schema_id = s.schema_id ${where}
       ORDER BY [schema], name`, params);
    return r.rows.map((x) => ({ schema: x.schema, name: x.name, type: x.type }));
  }

  async getTableColumns(schema: string, table: string): Promise<ColumnMeta[]> {
    const r = await this.exec(
      `SELECT c.name, t.name AS data_type, c.is_nullable, dc.definition AS default_def,
              c.is_identity, c.max_length, c.precision, c.scale,
              CASE WHEN EXISTS (SELECT 1 FROM sys.index_columns ic
                JOIN sys.indexes i ON i.object_id = ic.object_id AND i.index_id = ic.index_id
                WHERE ic.object_id = c.object_id AND ic.column_id = c.column_id AND i.is_primary_key = 1) THEN 1 ELSE 0 END AS is_pk
         FROM sys.columns c
         JOIN sys.types t ON t.user_type_id = c.user_type_id
    LEFT JOIN sys.default_constraints dc ON dc.object_id = c.default_object_id
        WHERE c.object_id = OBJECT_ID(@qname)
        ORDER BY c.column_id`,
      [{ name: 'qname', type: TYPES.NVarChar, value: `${schema}.${table}` }]);
    return r.rows.map((x) => ({
      name: x.name, dataType: x.data_type,
      nullable: !!x.is_nullable, defaultValue: x.default_def,
      isPrimaryKey: !!x.is_pk, isUnique: false, isIdentity: !!x.is_identity,
      charMaxLength: x.max_length, numericPrecision: x.precision, numericScale: x.scale,
    }));
  }

  async getTableData(q: TableDataQuery): Promise<TableDataResult> {
    const cols = await this.getTableColumns(q.schema, q.table);
    const names = new Set(cols.map((c) => c.name));
    const fqtn = `${quoteMssql(q.schema)}.${quoteMssql(q.table)}`;
    const where: string[] = []; const params: any[] = [];
    let pi = 0;
    for (const f of q.filters ?? []) {
      whitelistIdent(f.column, names);
      const op = f.op.toLowerCase();
      if (op === 'is null' || op === 'is not null') where.push(`${quoteMssql(f.column)} ${op.toUpperCase()}`);
      else {
        const p = `p${pi++}`;
        where.push(`${quoteMssql(f.column)} ${op.toUpperCase()} @${p}`);
        params.push({ name: p, type: TYPES.NVarChar, value: String(f.value) });
      }
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const orderSql = (q.orderBy ?? []).map((o) => {
      whitelistIdent(o.column, names);
      return `${quoteMssql(o.column)} ${o.direction === 'desc' ? 'DESC' : 'ASC'}`;
    }).join(', ') || '(SELECT NULL)';
    const limit = Math.max(1, Math.min(q.limit, 1000));
    const offset = Math.max(0, q.offset);
    const countR = await this.exec(`SELECT COUNT(*) AS c FROM ${fqtn} ${whereSql}`, params);
    const rowsR = await this.exec(
      `SELECT * FROM ${fqtn} ${whereSql} ORDER BY ${orderSql} OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`, params);
    return { columns: cols, rows: rowsR.rows, total: countR.rows[0].c };
  }

  async insertRow(schema: string, table: string, values: Record<string, unknown>) {
    const cols = await this.getTableColumns(schema, table);
    const allowed = new Set(cols.map((c) => c.name));
    const keys = Object.keys(values).filter((k) => allowed.has(k));
    const fqtn = `${quoteMssql(schema)}.${quoteMssql(table)}`;
    if (!keys.length) {
      await this.exec(`INSERT INTO ${fqtn} DEFAULT VALUES`);
      return values;
    }
    const params = keys.map((k, i) => ({ name: `p${i}`, type: TYPES.NVarChar, value: values[k] == null ? null : String(values[k]) }));
    const sql = `INSERT INTO ${fqtn} (${keys.map(quoteMssql).join(',')}) VALUES (${keys.map((_, i) => `@p${i}`).join(',')})`;
    await this.exec(sql, params);
    return values;
  }

  async updateRow(schema: string, table: string, pk: Record<string, unknown>, values: Record<string, unknown>) {
    const cols = await this.getTableColumns(schema, table);
    const allowed = new Set(cols.map((c) => c.name));
    const setKeys = Object.keys(values).filter((k) => allowed.has(k));
    const pkKeys = Object.keys(pk).filter((k) => allowed.has(k));
    if (!setKeys.length) throw new BadRequestException('No valid columns to update');
    if (!pkKeys.length) throw new BadRequestException('Primary key required');
    const params: any[] = [];
    const setSql = setKeys.map((k, i) => { params.push({ name: `s${i}`, type: TYPES.NVarChar, value: values[k] == null ? null : String(values[k]) }); return `${quoteMssql(k)} = @s${i}`; }).join(', ');
    const whereSql = pkKeys.map((k, i) => { params.push({ name: `w${i}`, type: TYPES.NVarChar, value: String(pk[k]) }); return `${quoteMssql(k)} = @w${i}`; }).join(' AND ');
    await this.exec(`UPDATE ${quoteMssql(schema)}.${quoteMssql(table)} SET ${setSql} WHERE ${whereSql}`, params);
    return { ...pk, ...values };
  }

  async deleteRow(schema: string, table: string, pk: Record<string, unknown>) {
    const cols = await this.getTableColumns(schema, table);
    const allowed = new Set(cols.map((c) => c.name));
    const pkKeys = Object.keys(pk).filter((k) => allowed.has(k));
    if (!pkKeys.length) throw new BadRequestException('Primary key required');
    const params = pkKeys.map((k, i) => ({ name: `w${i}`, type: TYPES.NVarChar, value: String(pk[k]) }));
    const whereSql = pkKeys.map((_, i) => `${quoteMssql(pkKeys[i])} = @w${i}`).join(' AND ');
    const r = await this.exec(`DELETE FROM ${quoteMssql(schema)}.${quoteMssql(table)} WHERE ${whereSql}`, params);
    return r.rowCount;
  }

  async deleteRows(schema: string, table: string, pks: Record<string, unknown>[]) {
    if (!pks.length) return 0;
    const cols = await this.getTableColumns(schema, table);
    const allowed = new Set(cols.map((c) => c.name));
    const firstKeys = Object.keys(pks[0]).filter((k) => allowed.has(k));
    if (!firstKeys.length) throw new BadRequestException('Primary key required');
    for (const pk of pks) {
      const ks = Object.keys(pk).filter((k) => allowed.has(k));
      if (ks.length !== firstKeys.length || firstKeys.some((k) => !ks.includes(k))) {
        throw new BadRequestException('Inconsistent primary-key shape across rows');
      }
    }
    const params: any[] = [];
    const tuples = pks.map((pk, i) => {
      const inner = firstKeys.map((k, j) => {
        const n = `p${i}_${j}`;
        params.push({ name: n, type: TYPES.NVarChar, value: String(pk[k]) });
        return `@${n}`;
      });
      return `(${inner.join(', ')})`;
    });
    const cols2 = firstKeys.map(quoteMssql).join(', ');
    const sql = `DELETE FROM ${quoteMssql(schema)}.${quoteMssql(table)} WHERE (${cols2}) IN (${tuples.join(', ')})`;
    const r = await this.exec(sql, params);
    return r.rowCount;
  }

  async getTableDefinition(schema: string, table: string): Promise<string> {
    // MSSQL has no SHOW CREATE TABLE. Reconstruct from sys catalogs.
    const colsR = await this.exec(
      `SELECT c.name, t.name AS data_type, c.is_nullable, dc.definition AS default_def,
              c.is_identity, c.max_length, c.precision, c.scale
         FROM sys.columns c
         JOIN sys.types t ON t.user_type_id = c.user_type_id
    LEFT JOIN sys.default_constraints dc ON dc.object_id = c.default_object_id
        WHERE c.object_id = OBJECT_ID(@qname)
        ORDER BY c.column_id`,
      [{ name: 'qname', type: TYPES.NVarChar, value: `${schema}.${table}` }],
    );
    if (!colsR.rows.length) throw new BadRequestException(`Unknown table ${schema}.${table}`);
    const parts: string[] = [];
    for (const c of colsR.rows) {
      let s = `  ${quoteMssql(c.name)} ${c.data_type}`;
      s += c.is_nullable ? ' NULL' : ' NOT NULL';
      if (c.is_identity) s += ' IDENTITY';
      if (c.default_def) s += ` DEFAULT ${c.default_def}`;
      parts.push(s);
    }
    return `CREATE TABLE ${quoteMssql(schema)}.${quoteMssql(table)} (\n${parts.join(',\n')}\n);`;
  }

  async runRawQuery(sql: string, _params: unknown[] = []): Promise<QueryResult> {
    const start = Date.now();
    const r = await this.exec(sql);
    return {
      rows: r.rows, fields: r.rows[0] ? Object.keys(r.rows[0]).map((n) => ({ name: n })) : [],
      rowCount: r.rowCount, command: sql.trim().split(/\s+/)[0]?.toUpperCase(), durationMs: Date.now() - start,
    };
  }

  async introspectForER(schema?: string): Promise<ErDiagram> {
    const tables = await this.listTables(schema);
    const out: ErDiagram = { tables: [], foreignKeys: [] };
    for (const t of tables) {
      out.tables.push({ schema: t.schema, name: t.name, columns: await this.getTableColumns(t.schema, t.name) });
    }
    const fk = await this.exec(
      `SELECT fk.name, SCHEMA_NAME(fk.schema_id) AS [schema],
              OBJECT_NAME(fk.parent_object_id) AS [table],
              COL_NAME(fkc.parent_object_id, fkc.parent_column_id) AS col,
              SCHEMA_NAME(rt.schema_id) AS ref_schema,
              OBJECT_NAME(fkc.referenced_object_id) AS ref_table,
              COL_NAME(fkc.referenced_object_id, fkc.referenced_column_id) AS ref_col,
              fkc.constraint_column_id AS ord
         FROM sys.foreign_keys fk
         JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
         JOIN sys.tables rt ON rt.object_id = fkc.referenced_object_id
         ORDER BY fk.name, fkc.constraint_column_id`);
    const grouped = new Map<string, any>();
    for (const r of fk.rows) {
      if (!grouped.has(r.name)) grouped.set(r.name, {
        name: r.name, schema: r.schema, table: r.table, columns: [],
        refSchema: r.ref_schema, refTable: r.ref_table, refColumns: [],
      });
      const g = grouped.get(r.name); g.columns.push(r.col); g.refColumns.push(r.ref_col);
    }
    out.foreignKeys = [...grouped.values()];
    return out;
  }

  async listFunctions(): Promise<FunctionMeta[]> {
    const r = await this.exec(
      `SELECT SCHEMA_NAME(schema_id) AS [schema], name FROM sys.objects WHERE type IN ('FN','IF','TF') ORDER BY name`);
    return r.rows.map((x) => ({ schema: x.schema, name: x.name }));
  }

  async listTriggers(): Promise<TriggerMeta[]> {
    const r = await this.exec(
      `SELECT SCHEMA_NAME(t.schema_id) AS [schema], OBJECT_NAME(tr.parent_id) AS [table], tr.name
         FROM sys.triggers tr JOIN sys.tables t ON t.object_id = tr.parent_id`);
    return r.rows as TriggerMeta[];
  }

  async listIndexes(schema?: string, table?: string): Promise<IndexMeta[]> {
    const r = await this.exec(
      `SELECT SCHEMA_NAME(t.schema_id) AS [schema], t.name AS [table], i.name,
              i.is_unique, i.is_primary_key, i.type_desc,
              COL_NAME(ic.object_id, ic.column_id) AS col, ic.key_ordinal
         FROM sys.indexes i
         JOIN sys.tables t ON t.object_id = i.object_id
         JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
        WHERE i.name IS NOT NULL
        ORDER BY t.name, i.name, ic.key_ordinal`);
    const grouped = new Map<string, IndexMeta>();
    for (const r0 of r.rows) {
      if (schema && r0.schema !== schema) continue;
      if (table && r0.table !== table) continue;
      const k = `${r0.schema}.${r0.table}.${r0.name}`;
      if (!grouped.has(k)) grouped.set(k, {
        name: r0.name, schema: r0.schema, table: r0.table, columns: [],
        isUnique: !!r0.is_unique, isPrimary: !!r0.is_primary_key, method: r0.type_desc,
      });
      grouped.get(k)!.columns.push(r0.col);
    }
    return [...grouped.values()];
  }

  async createTable(spec: CreateTableSpec, execute: boolean) {
    const colDefs = spec.columns.map((c) => this.colDefinition(c));
    const fks = (spec.foreignKeys ?? []).map((fk) => this.fkClause(spec, fk));
    const qualified = `${quoteMssql(spec.schema)}.${quoteMssql(spec.name)}`;
    const main = `CREATE TABLE ${qualified} (\n  ${[...colDefs, ...fks].join(',\n  ')}\n)`;

    // MSSQL stores column comments as extended properties.
    const comments = spec.columns
      .filter((c) => c.comment)
      .map(
        (c) =>
          `EXEC sp_addextendedproperty 'MS_Description', ${this.quoteLiteral(c.comment!)}, 'SCHEMA', ${this.quoteLiteral(
            spec.schema,
          )}, 'TABLE', ${this.quoteLiteral(spec.name)}, 'COLUMN', ${this.quoteLiteral(c.name)}`,
      );
    const stmts = [main, ...comments];
    const sql = stmts.join(';\n') + ';';
    if (execute) for (const s of stmts) await this.exec(s);
    return { sql, executed: execute };
  }

  async alterTable(spec: AlterTableSpec, execute: boolean) {
    const stmts: string[] = [];
    const base = `ALTER TABLE ${quoteMssql(spec.schema)}.${quoteMssql(spec.name)}`;
    for (const c of spec.addColumns ?? []) {
      stmts.push(`${base} ADD ${this.colDefinition(c)}`);
      if (c.comment) {
        stmts.push(
          `EXEC sp_addextendedproperty 'MS_Description', ${this.quoteLiteral(c.comment)}, 'SCHEMA', ${this.quoteLiteral(
            spec.schema,
          )}, 'TABLE', ${this.quoteLiteral(spec.name)}, 'COLUMN', ${this.quoteLiteral(c.name)}`,
        );
      }
    }
    for (const n of spec.dropColumns ?? []) stmts.push(`${base} DROP COLUMN ${quoteMssql(n)}`);
    for (const n of spec.dropConstraints ?? []) stmts.push(`${base} DROP CONSTRAINT ${quoteMssql(n)}`);
    for (const r of spec.renameColumns ?? []) stmts.push(`EXEC sp_rename '${spec.schema}.${spec.name}.${r.from}', '${r.to}', 'COLUMN'`);
    for (const a of spec.alterColumns ?? []) {
      if (a.type) stmts.push(`${base} ALTER COLUMN ${quoteMssql(a.name)} ${assertSqlType(a.type)}${a.nullable === false ? ' NOT NULL' : ' NULL'}`);
    }
    for (const fk of spec.addForeignKeys ?? []) stmts.push(`${base} ADD ${this.fkClause(spec, fk)}`);
    if (spec.renameTo) stmts.push(`EXEC sp_rename '${spec.schema}.${spec.name}', '${spec.renameTo}'`);
    const sql = stmts.join(';\n') + (stmts.length ? ';' : '');
    if (execute) for (const s of stmts) await this.exec(s);
    return { sql, executed: execute && stmts.length > 0 };
  }

  async dropTable(schema: string, table: string, execute: boolean) {
    const sql = `DROP TABLE ${quoteMssql(schema)}.${quoteMssql(table)}`;
    if (execute) await this.exec(sql);
    return { sql, executed: execute };
  }

  async close() { /* per-call connections */ }
}
