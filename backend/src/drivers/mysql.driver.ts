import { BadRequestException } from '@nestjs/common';
import { createPool, Pool, PoolConnection } from 'mysql2/promise';
import { Dialect } from '@prisma/client';
import {
  AlterTableSpec, ColumnMeta, ColumnSpec, ConnectionCredentials, CreateTableSpec, DriverOptions,
  ErDiagram, ForeignKeySpec, FunctionMeta, IDatabaseDriver, IndexMeta, QueryResult, TableDataQuery,
  TableDataResult, TableRef, TriggerMeta,
} from './driver.interface';
import { assertCheckExpr, assertDefaultExpr, assertFkAction, assertSqlType, quoteMysql, whitelistIdent } from './quote.util';
import { toDriverHttpError } from './driver-errors';

export class MysqlDriver implements IDatabaseDriver {
  readonly dialect = Dialect.MYSQL;
  private pool: Pool;
  private readonly timeoutMs: number;
  private readonly readOnly: boolean;
  private readonly defaultSchema: string;

  constructor(creds: ConnectionCredentials, opts: DriverOptions = {}) {
    this.pool = createPool({
      host: creds.host, port: creds.port ?? 3306,
      user: creds.user, password: creds.password, database: creds.database,
      connectionLimit: 5, connectTimeout: 10_000, multipleStatements: false,
      ssl: creds.sslMode && creds.sslMode !== 'disable' ? {} : undefined,
    });
    this.timeoutMs = opts.statementTimeoutMs ?? 30_000;
    this.readOnly = !!opts.readOnly;
    this.defaultSchema = creds.database ?? '';
  }

  private async withConn<T>(fn: (c: PoolConnection) => Promise<T>): Promise<T> {
    let conn: PoolConnection;
    try {
      conn = await this.pool.getConnection();
    } catch (err) {
      throw toDriverHttpError(err);
    }
    try {
      await conn.query(`SET SESSION MAX_EXECUTION_TIME=${Number(this.timeoutMs)}`).catch(() => {});
      if (this.readOnly) await conn.query('SET SESSION TRANSACTION READ ONLY').catch(() => {});
      return await fn(conn);
    } catch (err) {
      throw toDriverHttpError(err);
    } finally {
      conn.release();
    }
  }

  private async poolQuery<T = any>(sql: string, params?: unknown[]): Promise<[T, any]> {
    try {
      return (await this.pool.query(sql, params as never)) as [T, any];
    } catch (err) {
      throw toDriverHttpError(err);
    }
  }

  private quoteLiteral(v: string): string {
    return `'${v.replace(/'/g, "''").replace(/\\/g, '\\\\')}'`;
  }

  private renderDefault(c: { default?: string | null; defaultIsExpression?: boolean }): string | null {
    if (c.default == null || c.default === '') return null;
    const safe = assertDefaultExpr(c.default);
    return c.defaultIsExpression ? `(${safe})` : safe;
  }

  private colDefinition(c: ColumnSpec): string {
    const parts = [quoteMysql(c.name), assertSqlType(c.type)];
    if (c.nullable === false) parts.push('NOT NULL');
    const dv = this.renderDefault(c);
    if (dv != null) parts.push(`DEFAULT ${dv}`);
    if (c.primaryKey) parts.push('PRIMARY KEY');
    if (c.unique) parts.push('UNIQUE');
    if (c.check) parts.push(`CHECK (${assertCheckExpr(c.check)})`);
    if (c.comment) parts.push(`COMMENT ${this.quoteLiteral(c.comment)}`);
    return parts.join(' ');
  }

  private fkClause(spec: CreateTableSpec | AlterTableSpec, fk: ForeignKeySpec): string {
    const refs = fk.refColumns.map(quoteMysql).join(', ');
    const cols = fk.columns.map(quoteMysql).join(', ');
    const refTbl = `${quoteMysql(fk.refSchema ?? spec.schema)}.${quoteMysql(fk.refTable)}`;
    let s = `FOREIGN KEY (${cols}) REFERENCES ${refTbl} (${refs})`;
    const onDel = assertFkAction(fk.onDelete);
    const onUpd = assertFkAction(fk.onUpdate);
    if (onDel) s += ` ON DELETE ${onDel}`;
    if (onUpd) s += ` ON UPDATE ${onUpd}`;
    return s;
  }

  async testConnection() {
    try {
      const [rows] = await this.poolQuery<any>('SELECT VERSION() as v');
      return { ok: true, version: rows?.[0]?.v };
    } catch (e) { return { ok: false, error: (e as Error).message }; }
  }

  async listSchemas(): Promise<string[]> {
    const [rows] = await this.poolQuery<any>(
      `SELECT schema_name FROM information_schema.schemata
        WHERE schema_name NOT IN ('mysql','information_schema','performance_schema','sys')
        ORDER BY schema_name`);
    return rows.map((x: any) => x.schema_name ?? x.SCHEMA_NAME);
  }

  async listTables(schema?: string): Promise<TableRef[]> {
    const s = schema ?? this.defaultSchema;
    const [rows] = await this.poolQuery<any>(
      `SELECT table_schema AS 'schema', table_name AS 'name',
              LOWER(table_type) AS 'type', table_comment AS 'comment', table_rows AS 'est'
         FROM information_schema.tables
        WHERE table_schema = ? ORDER BY table_name`, [s]);
    return rows.map((r: any) => ({
      schema: r.schema, name: r.name,
      type: r.type?.includes('view') ? 'view' : 'table',
      comment: r.comment, estimatedRows: r.est ? Number(r.est) : null,
    }));
  }

  async getTableColumns(schema: string, table: string): Promise<ColumnMeta[]> {
    const [rows] = await this.poolQuery<any>(
      `SELECT column_name AS name, data_type, is_nullable, column_default, column_key,
              character_maximum_length, numeric_precision, numeric_scale, extra, column_comment
         FROM information_schema.columns
        WHERE table_schema = ? AND table_name = ?
        ORDER BY ordinal_position`, [schema, table]);
    return rows.map((r: any) => ({
      name: r.name ?? r.COLUMN_NAME,
      dataType: r.data_type ?? r.DATA_TYPE,
      nullable: (r.is_nullable ?? r.IS_NULLABLE) === 'YES',
      defaultValue: r.column_default ?? r.COLUMN_DEFAULT ?? null,
      isPrimaryKey: (r.column_key ?? r.COLUMN_KEY) === 'PRI',
      isUnique: (r.column_key ?? r.COLUMN_KEY) === 'UNI',
      isIdentity: String(r.extra ?? r.EXTRA ?? '').includes('auto_increment'),
      comment: r.column_comment ?? r.COLUMN_COMMENT,
      charMaxLength: r.character_maximum_length ?? r.CHARACTER_MAXIMUM_LENGTH,
      numericPrecision: r.numeric_precision ?? r.NUMERIC_PRECISION,
      numericScale: r.numeric_scale ?? r.NUMERIC_SCALE,
    }));
  }

  async getTableData(q: TableDataQuery): Promise<TableDataResult> {
    const cols = await this.getTableColumns(q.schema, q.table);
    const names = new Set(cols.map((c) => c.name));
    const fqtn = `${quoteMysql(q.schema)}.${quoteMysql(q.table)}`;
    const where: string[] = []; const params: unknown[] = [];
    for (const f of q.filters ?? []) {
      whitelistIdent(f.column, names);
      const op = f.op.toLowerCase();
      if (op === 'is null' || op === 'is not null') where.push(`${quoteMysql(f.column)} ${op.toUpperCase()}`);
      else { where.push(`${quoteMysql(f.column)} ${op.toUpperCase()} ?`); params.push(f.value); }
    }
    if (q.extraPredicate && q.extraPredicate.trim()) {
      where.push(`(${q.extraPredicate})`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const orderSql = (q.orderBy ?? []).map((o) => {
      whitelistIdent(o.column, names);
      return `${quoteMysql(o.column)} ${o.direction === 'desc' ? 'DESC' : 'ASC'}`;
    }).join(', ');
    return this.withConn(async (c) => {
      const limit = Math.max(1, Math.min(q.limit, 1000));
      const offset = Math.max(0, q.offset);
      const EXACT_COUNT_THRESHOLD = 50_000;

      // information_schema.tables.table_rows is a cheap estimate for InnoDB.
      const [er] = await c.query<any>(
        `SELECT IFNULL(table_rows, 0) AS est FROM information_schema.tables WHERE table_schema = ? AND table_name = ?`,
        [q.schema, q.table],
      );
      const estimate = Number(er[0]?.est ?? 0);

      let total: number | null;
      let totalIsEstimate = false;
      if (!where.length) {
        if (estimate < EXACT_COUNT_THRESHOLD) {
          const [cr] = await c.query<any>(`SELECT COUNT(*) AS c FROM ${fqtn}`);
          total = Number(cr[0].c);
        } else {
          total = estimate;
          totalIsEstimate = true;
        }
      } else if (estimate < EXACT_COUNT_THRESHOLD) {
        const [cr] = await c.query<any>(`SELECT COUNT(*) AS c FROM ${fqtn} ${whereSql}`, params);
        total = Number(cr[0].c);
      } else {
        total = null;
      }

      const [rows] = await c.query<any>(
        `SELECT * FROM ${fqtn} ${whereSql} ${orderSql ? `ORDER BY ${orderSql}` : ''} LIMIT ${limit} OFFSET ${offset}`, params);
      return { columns: cols, rows, total, totalIsEstimate };
    });
  }

  async insertRow(schema: string, table: string, values: Record<string, unknown>) {
    const cols = await this.getTableColumns(schema, table);
    const allowed = new Set(cols.map((c) => c.name));
    const keys = Object.keys(values).filter((k) => allowed.has(k));
    const fqtn = `${quoteMysql(schema)}.${quoteMysql(table)}`;
    if (!keys.length) {
      // All columns rely on defaults / auto_increment.
      await this.withConn((c) => c.query(`INSERT INTO ${fqtn} () VALUES ()`));
      return values;
    }
    const ph = keys.map(() => '?').join(',');
    const sql = `INSERT INTO ${fqtn} (${keys.map(quoteMysql).join(',')}) VALUES (${ph})`;
    await this.withConn((c) => c.query(sql, keys.map((k) => values[k])));
    return values;
  }

  async updateRow(schema: string, table: string, pk: Record<string, unknown>, values: Record<string, unknown>) {
    const cols = await this.getTableColumns(schema, table);
    const allowed = new Set(cols.map((c) => c.name));
    const setKeys = Object.keys(values).filter((k) => allowed.has(k));
    const pkKeys = Object.keys(pk).filter((k) => allowed.has(k));
    if (!setKeys.length) throw new BadRequestException('No valid columns to update');
    if (!pkKeys.length) throw new BadRequestException('Primary key required');
    const setSql = setKeys.map((k) => `${quoteMysql(k)} = ?`).join(', ');
    const whereSql = pkKeys.map((k) => `${quoteMysql(k)} = ?`).join(' AND ');
    const params = [...setKeys.map((k) => values[k]), ...pkKeys.map((k) => pk[k])];
    const sql = `UPDATE ${quoteMysql(schema)}.${quoteMysql(table)} SET ${setSql} WHERE ${whereSql}`;
    await this.withConn((c) => c.query(sql, params));
    return { ...pk, ...values };
  }

  async deleteRow(schema: string, table: string, pk: Record<string, unknown>) {
    const cols = await this.getTableColumns(schema, table);
    const allowed = new Set(cols.map((c) => c.name));
    const pkKeys = Object.keys(pk).filter((k) => allowed.has(k));
    if (!pkKeys.length) throw new BadRequestException('Primary key required');
    const whereSql = pkKeys.map((k) => `${quoteMysql(k)} = ?`).join(' AND ');
    const sql = `DELETE FROM ${quoteMysql(schema)}.${quoteMysql(table)} WHERE ${whereSql}`;
    const r = await this.withConn((c) => c.query<any>(sql, pkKeys.map((k) => pk[k])));
    return (r as any)[0]?.affectedRows ?? 0;
  }

  async fetchRowByPk(schema: string, table: string, pk: Record<string, unknown>) {
    const cols = await this.getTableColumns(schema, table);
    const allowed = new Set(cols.map((c) => c.name));
    const keys = Object.keys(pk).filter((k) => allowed.has(k));
    if (!keys.length) throw new BadRequestException('Primary key required');
    const params: unknown[] = [];
    const whereSql = keys.map((k) => {
      params.push(pk[k]);
      return `${quoteMysql(k)} = ?`;
    }).join(' AND ');
    const [rows] = await this.poolQuery<any>(
      `SELECT * FROM ${quoteMysql(schema)}.${quoteMysql(table)} WHERE ${whereSql} LIMIT 1`,
      params,
    );
    return rows[0] ?? null;
  }

  async fetchRowsByPks(schema: string, table: string, pks: Record<string, unknown>[]) {
    if (!pks.length) return [];
    const cols = await this.getTableColumns(schema, table);
    const allowed = new Set(cols.map((c) => c.name));
    const firstKeys = Object.keys(pks[0]).filter((k) => allowed.has(k));
    if (!firstKeys.length) throw new BadRequestException('Primary key required');
    const params: unknown[] = [];
    const tuples = pks.map((pk) => {
      const ph = firstKeys.map((k) => {
        params.push(pk[k]);
        return '?';
      });
      return `(${ph.join(', ')})`;
    });
    const cols2 = firstKeys.map(quoteMysql).join(', ');
    const [rows] = await this.poolQuery<any>(
      `SELECT * FROM ${quoteMysql(schema)}.${quoteMysql(table)} WHERE (${cols2}) IN (${tuples.join(', ')})`,
      params,
    );
    return rows as Record<string, unknown>[];
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
    const params: unknown[] = [];
    const tuples = pks.map((pk) => {
      const ph = firstKeys.map((k) => {
        params.push(pk[k]);
        return '?';
      });
      return `(${ph.join(', ')})`;
    });
    const cols2 = firstKeys.map(quoteMysql).join(', ');
    const sql = `DELETE FROM ${quoteMysql(schema)}.${quoteMysql(table)} WHERE (${cols2}) IN (${tuples.join(', ')})`;
    const r = await this.withConn((c) => c.query<any>(sql, params));
    return (r as any)[0]?.affectedRows ?? 0;
  }

  async bulkUpdateRows(
    schema: string,
    table: string,
    pks: Record<string, unknown>[],
    values: Record<string, unknown>,
  ) {
    if (!pks.length) return 0;
    const cols = await this.getTableColumns(schema, table);
    const allowed = new Set(cols.map((c) => c.name));
    const setKeys = Object.keys(values).filter((k) => allowed.has(k));
    if (!setKeys.length) throw new BadRequestException('No valid columns to update');
    const firstKeys = Object.keys(pks[0]).filter((k) => allowed.has(k));
    if (!firstKeys.length) throw new BadRequestException('Primary key required');
    for (const pk of pks) {
      const ks = Object.keys(pk).filter((k) => allowed.has(k));
      if (ks.length !== firstKeys.length || firstKeys.some((k) => !ks.includes(k))) {
        throw new BadRequestException('Inconsistent primary-key shape across rows');
      }
    }
    const params: unknown[] = [];
    const setSql = setKeys
      .map((k) => {
        params.push(values[k]);
        return `${quoteMysql(k)} = ?`;
      })
      .join(', ');
    const tuples = pks.map((pk) => {
      const ph = firstKeys.map((k) => {
        params.push(pk[k]);
        return '?';
      });
      return `(${ph.join(', ')})`;
    });
    const cols2 = firstKeys.map(quoteMysql).join(', ');
    const sql = `UPDATE ${quoteMysql(schema)}.${quoteMysql(table)} SET ${setSql} WHERE (${cols2}) IN (${tuples.join(', ')})`;
    const r = await this.withConn((c) => c.query<any>(sql, params));
    return (r as any)[0]?.affectedRows ?? 0;
  }

  async runRawQuery(sql: string, params: unknown[] = []): Promise<QueryResult> {
    const start = Date.now();
    return this.withConn(async (c) => {
      const [rows, fields] = await c.query<any>(sql, params);
      const isArray = Array.isArray(rows);
      return {
        rows: isArray ? rows : [],
        fields: isArray ? (fields ?? []).map((f: any) => ({ name: f.name })) : [],
        rowCount: isArray ? rows.length : (rows as any).affectedRows ?? 0,
        command: sql.trim().split(/\s+/)[0]?.toUpperCase(),
        durationMs: Date.now() - start,
      };
    });
  }

  async introspectForER(schema?: string): Promise<ErDiagram> {
    const s = schema ?? this.defaultSchema;
    // One query for every column of every table — avoids N+1 for big schemas.
    const [allCols] = await this.poolQuery<any>(
      `SELECT table_schema AS 'schema', table_name AS 'table', column_name AS name,
              data_type, is_nullable, column_default, column_key,
              character_maximum_length, numeric_precision, numeric_scale, extra, column_comment
         FROM information_schema.columns
        WHERE table_schema = ?
        ORDER BY table_schema, table_name, ordinal_position`, [s]);
    const byTable = new Map<string, { schema: string; name: string; columns: ColumnMeta[] }>();
    for (const r of allCols as any[]) {
      const key = `${r.schema}.${r.table}`;
      let entry = byTable.get(key);
      if (!entry) {
        entry = { schema: r.schema, name: r.table, columns: [] };
        byTable.set(key, entry);
      }
      entry.columns.push({
        name: r.name,
        dataType: r.data_type,
        nullable: r.is_nullable === 'YES',
        defaultValue: r.column_default ?? null,
        isPrimaryKey: r.column_key === 'PRI',
        isUnique: r.column_key === 'UNI',
        isIdentity: String(r.extra ?? '').includes('auto_increment'),
        comment: r.column_comment,
        charMaxLength: r.character_maximum_length,
        numericPrecision: r.numeric_precision,
        numericScale: r.numeric_scale,
      });
    }
    const out: ErDiagram = { tables: Array.from(byTable.values()), foreignKeys: [] };
    const [fks] = await this.poolQuery<any>(
      `SELECT kcu.constraint_name AS name, kcu.table_schema AS 'schema', kcu.table_name AS 'table',
              kcu.column_name, kcu.referenced_table_schema AS ref_schema,
              kcu.referenced_table_name AS ref_table, kcu.referenced_column_name AS ref_column,
              kcu.ordinal_position, rc.delete_rule, rc.update_rule
         FROM information_schema.key_column_usage kcu
         JOIN information_schema.referential_constraints rc
           ON rc.constraint_name = kcu.constraint_name AND rc.constraint_schema = kcu.constraint_schema
        WHERE kcu.table_schema = ? AND kcu.referenced_table_name IS NOT NULL
        ORDER BY kcu.constraint_name, kcu.ordinal_position`, [s]);
    const grouped = new Map<string, any>();
    for (const r of fks as any[]) {
      const key = `${r.schema}.${r.name}`;
      if (!grouped.has(key)) grouped.set(key, {
        name: r.name, schema: r.schema, table: r.table, columns: [],
        refSchema: r.ref_schema, refTable: r.ref_table, refColumns: [],
        onDelete: r.delete_rule, onUpdate: r.update_rule,
      });
      const g = grouped.get(key);
      g.columns.push(r.column_name); g.refColumns.push(r.ref_column);
    }
    out.foreignKeys = [...grouped.values()];
    return out;
  }

  async listFunctions(schema?: string): Promise<FunctionMeta[]> {
    const s = schema ?? this.defaultSchema;
    const [rows] = await this.poolQuery<any>(
      `SELECT routine_schema AS 'schema', routine_name AS name, data_type AS ret
         FROM information_schema.routines WHERE routine_schema = ? ORDER BY routine_name`, [s]);
    return rows.map((r: any) => ({ schema: r.schema, name: r.name, returnType: r.ret }));
  }

  async listTriggers(schema?: string): Promise<TriggerMeta[]> {
    const s = schema ?? this.defaultSchema;
    const [rows] = await this.poolQuery<any>(
      `SELECT trigger_schema AS 'schema', event_object_table AS 'table', trigger_name AS name,
              action_timing AS timing, event_manipulation AS event, action_statement AS statement
         FROM information_schema.triggers WHERE trigger_schema = ?`, [s]);
    return rows as TriggerMeta[];
  }

  async listIndexes(schema?: string, table?: string): Promise<IndexMeta[]> {
    const s = schema ?? this.defaultSchema;
    const [rows] = await this.poolQuery<any>(
      `SELECT table_schema AS 'schema', table_name AS 'table', index_name AS name,
              column_name, non_unique, index_type, seq_in_index
         FROM information_schema.statistics
        WHERE table_schema = ? ${table ? 'AND table_name = ?' : ''}
        ORDER BY table_name, index_name, seq_in_index`, table ? [s, table] : [s]);
    const grouped = new Map<string, IndexMeta>();
    for (const r of rows as any[]) {
      const k = `${r.schema}.${r.table}.${r.name}`;
      if (!grouped.has(k)) grouped.set(k, {
        name: r.name, schema: r.schema, table: r.table, columns: [],
        isUnique: r.non_unique === 0, isPrimary: r.name === 'PRIMARY', method: r.index_type,
      });
      grouped.get(k)!.columns.push(r.column_name);
    }
    return [...grouped.values()];
  }

  async getTableDefinition(schema: string, table: string): Promise<string> {
    const [rows] = await this.poolQuery<any>(
      `SHOW CREATE TABLE ${quoteMysql(schema)}.${quoteMysql(table)}`,
    );
    const row = rows?.[0] ?? {};
    // MySQL returns the DDL in a column called "Create Table" (or "Create View").
    return row['Create Table'] ?? row['Create View'] ?? '';
  }

  async createTable(spec: CreateTableSpec, execute: boolean) {
    const colDefs = spec.columns.map((c) => this.colDefinition(c));
    const fks = (spec.foreignKeys ?? []).map((fk) => this.fkClause(spec, fk));
    const qualified = `${quoteMysql(spec.schema)}.${quoteMysql(spec.name)}`;
    const sql = `CREATE TABLE ${qualified} (\n  ${[...colDefs, ...fks].join(',\n  ')}\n)`;
    if (execute) await this.withConn((c) => c.query(sql));
    return { sql, executed: execute };
  }

  async alterTable(spec: AlterTableSpec, execute: boolean) {
    const parts: string[] = [];
    for (const c of spec.addColumns ?? []) parts.push(`ADD COLUMN ${this.colDefinition(c)}`);
    for (const n of spec.dropColumns ?? []) parts.push(`DROP COLUMN ${quoteMysql(n)}`);
    for (const n of spec.dropConstraints ?? []) parts.push(`DROP CONSTRAINT ${quoteMysql(n)}`);
    for (const r of spec.renameColumns ?? []) parts.push(`RENAME COLUMN ${quoteMysql(r.from)} TO ${quoteMysql(r.to)}`);
    for (const a of spec.alterColumns ?? []) {
      if (a.type) {
        let s = `MODIFY COLUMN ${quoteMysql(a.name)} ${assertSqlType(a.type)}`;
        if (a.nullable === false) s += ' NOT NULL';
        if (a.default != null) s += ` DEFAULT ${assertDefaultExpr(a.default)}`;
        if (a.comment) s += ` COMMENT ${this.quoteLiteral(a.comment)}`;
        parts.push(s);
      } else if (a.comment !== undefined) {
        // MySQL ties comments to MODIFY COLUMN; standalone comment alter needs type repeat.
        // Fetch current type to reuse.
        // (Keeping simple here — ask user to pass type alongside a comment change.)
      }
    }
    for (const fk of spec.addForeignKeys ?? []) parts.push(`ADD ${this.fkClause(spec, fk)}`);
    if (spec.renameTo) parts.push(`RENAME TO ${quoteMysql(spec.renameTo)}`);
    const sql = parts.length ? `ALTER TABLE ${quoteMysql(spec.schema)}.${quoteMysql(spec.name)} ${parts.join(', ')}` : '';
    if (execute && sql) await this.withConn((c) => c.query(sql));
    return { sql, executed: execute && !!sql };
  }

  async dropTable(schema: string, table: string, execute: boolean) {
    const sql = `DROP TABLE ${quoteMysql(schema)}.${quoteMysql(table)}`;
    if (execute) await this.withConn((c) => c.query(sql));
    return { sql, executed: execute };
  }

  async close() { await this.pool.end(); }
}
