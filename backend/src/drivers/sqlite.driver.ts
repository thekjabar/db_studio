import { BadRequestException } from '@nestjs/common';
import Database from 'better-sqlite3';
import { Dialect } from '@prisma/client';
import {
  AlterTableSpec, ColumnMeta, ColumnSpec, ConnectionCredentials, CreateTableSpec, DriverOptions,
  ErDiagram, ForeignKeySpec, FunctionMeta, IDatabaseDriver, IndexMeta, QueryResult, TableDataQuery,
  TableDataResult, TableRef, TriggerMeta,
} from './driver.interface';
import { assertCheckExpr, assertDefaultExpr, assertFkAction, assertSqlType, quoteSqlite, whitelistIdent } from './quote.util';
import { toDriverHttpError } from './driver-errors';

export class SqliteDriver implements IDatabaseDriver {
  readonly dialect = Dialect.SQLITE;
  private db: Database.Database;
  private readonly readOnly: boolean;

  constructor(creds: ConnectionCredentials, opts: DriverOptions = {}) {
    if (!creds.filename) throw new Error('sqlite requires filename');
    this.readOnly = !!opts.readOnly;
    this.db = new Database(creds.filename, { readonly: this.readOnly, fileMustExist: false });
    this.db.pragma('journal_mode = WAL');
    const timeoutMs = opts.statementTimeoutMs ?? 30_000;
    this.db.pragma(`busy_timeout = ${Number(timeoutMs)}`);
  }

  async testConnection() {
    try {
      const v = this.db.prepare('SELECT sqlite_version() as v').get() as any;
      return { ok: true, version: v.v };
    } catch (e) { return { ok: false, error: (e as Error).message }; }
  }

  async listSchemas(): Promise<string[]> { return ['main']; }

  async listTables(): Promise<TableRef[]> {
    const rows = this.db.prepare(
      `SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as any[];
    return rows.map((r) => ({ schema: 'main', name: r.name, type: r.type === 'view' ? 'view' : 'table' }));
  }

  async getTableColumns(_schema: string, table: string): Promise<ColumnMeta[]> {
    const rows = this.db.prepare(`PRAGMA table_info(${quoteSqlite(table)})`).all() as any[];
    return rows.map((r) => ({
      name: r.name, dataType: r.type || 'ANY',
      nullable: r.notnull === 0, defaultValue: r.dflt_value,
      isPrimaryKey: r.pk > 0, isUnique: false, isIdentity: false,
    }));
  }

  async getTableData(q: TableDataQuery): Promise<TableDataResult> {
    const cols = await this.getTableColumns(q.schema, q.table);
    const names = new Set(cols.map((c) => c.name));
    const where: string[] = []; const params: unknown[] = [];
    for (const f of q.filters ?? []) {
      whitelistIdent(f.column, names);
      const op = f.op.toLowerCase();
      if (op === 'is null' || op === 'is not null') where.push(`${quoteSqlite(f.column)} ${op.toUpperCase()}`);
      else { where.push(`${quoteSqlite(f.column)} ${op.toUpperCase()} ?`); params.push(f.value); }
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const orderSql = (q.orderBy ?? []).map((o) => {
      whitelistIdent(o.column, names);
      return `${quoteSqlite(o.column)} ${o.direction === 'desc' ? 'DESC' : 'ASC'}`;
    }).join(', ');
    const total = (this.db.prepare(`SELECT COUNT(*) c FROM ${quoteSqlite(q.table)} ${whereSql}`).get(...params) as any).c;
    const limit = Math.max(1, Math.min(q.limit, 1000));
    const offset = Math.max(0, q.offset);
    const rows = this.db.prepare(`SELECT * FROM ${quoteSqlite(q.table)} ${whereSql} ${orderSql ? `ORDER BY ${orderSql}` : ''} LIMIT ${limit} OFFSET ${offset}`).all(...params) as any[];
    return { columns: cols, rows, total };
  }

  private renderDefault(c: { default?: string | null; defaultIsExpression?: boolean }): string | null {
    if (c.default == null || c.default === '') return null;
    const safe = assertDefaultExpr(c.default);
    return c.defaultIsExpression ? `(${safe})` : safe;
  }

  private colDefinition(c: ColumnSpec): string {
    const parts = [quoteSqlite(c.name), assertSqlType(c.type)];
    if (c.primaryKey) parts.push('PRIMARY KEY');
    if (c.nullable === false) parts.push('NOT NULL');
    if (c.unique) parts.push('UNIQUE');
    const dv = this.renderDefault(c);
    if (dv != null) parts.push(`DEFAULT ${dv}`);
    if (c.check) parts.push(`CHECK (${assertCheckExpr(c.check)})`);
    return parts.join(' ');
  }

  private fkClause(fk: ForeignKeySpec): string {
    const refs = fk.refColumns.map(quoteSqlite).join(', ');
    const cols = fk.columns.map(quoteSqlite).join(', ');
    let s = `FOREIGN KEY (${cols}) REFERENCES ${quoteSqlite(fk.refTable)} (${refs})`;
    const onDel = assertFkAction(fk.onDelete);
    const onUpd = assertFkAction(fk.onUpdate);
    if (onDel) s += ` ON DELETE ${onDel}`;
    if (onUpd) s += ` ON UPDATE ${onUpd}`;
    return s;
  }

  async insertRow(_s: string, table: string, values: Record<string, unknown>) {
    const cols = await this.getTableColumns('main', table);
    const allowed = new Set(cols.map((c) => c.name));
    const keys = Object.keys(values).filter((k) => allowed.has(k));
    try {
      if (!keys.length) {
        this.db.prepare(`INSERT INTO ${quoteSqlite(table)} DEFAULT VALUES`).run();
        return values;
      }
      const sql = `INSERT INTO ${quoteSqlite(table)} (${keys.map(quoteSqlite).join(',')}) VALUES (${keys.map(() => '?').join(',')})`;
      this.db.prepare(sql).run(...keys.map((k) => values[k] as any));
      return values;
    } catch (err) {
      throw toDriverHttpError(err);
    }
  }

  async updateRow(_s: string, table: string, pk: Record<string, unknown>, values: Record<string, unknown>) {
    const cols = await this.getTableColumns('main', table);
    const allowed = new Set(cols.map((c) => c.name));
    const setKeys = Object.keys(values).filter((k) => allowed.has(k));
    const pkKeys = Object.keys(pk).filter((k) => allowed.has(k));
    if (!setKeys.length) throw new BadRequestException('No valid columns to update');
    if (!pkKeys.length) throw new BadRequestException('Primary key required');
    const setSql = setKeys.map((k) => `${quoteSqlite(k)} = ?`).join(', ');
    const whereSql = pkKeys.map((k) => `${quoteSqlite(k)} = ?`).join(' AND ');
    const sql = `UPDATE ${quoteSqlite(table)} SET ${setSql} WHERE ${whereSql}`;
    try {
      this.db.prepare(sql).run(...setKeys.map((k) => values[k] as any), ...pkKeys.map((k) => pk[k] as any));
    } catch (err) {
      throw toDriverHttpError(err);
    }
    return { ...pk, ...values };
  }

  async deleteRow(_s: string, table: string, pk: Record<string, unknown>) {
    const cols = await this.getTableColumns('main', table);
    const allowed = new Set(cols.map((c) => c.name));
    const pkKeys = Object.keys(pk).filter((k) => allowed.has(k));
    if (!pkKeys.length) throw new BadRequestException('Primary key required');
    const whereSql = pkKeys.map((k) => `${quoteSqlite(k)} = ?`).join(' AND ');
    try {
      const r = this.db.prepare(`DELETE FROM ${quoteSqlite(table)} WHERE ${whereSql}`).run(...pkKeys.map((k) => pk[k] as any));
      return r.changes;
    } catch (err) {
      throw toDriverHttpError(err);
    }
  }

  async deleteRows(_s: string, table: string, pks: Record<string, unknown>[]) {
    if (!pks.length) return 0;
    const cols = await this.getTableColumns('main', table);
    const allowed = new Set(cols.map((c) => c.name));
    const firstKeys = Object.keys(pks[0]).filter((k) => allowed.has(k));
    if (!firstKeys.length) throw new BadRequestException('Primary key required');
    for (const pk of pks) {
      const ks = Object.keys(pk).filter((k) => allowed.has(k));
      if (ks.length !== firstKeys.length || firstKeys.some((k) => !ks.includes(k))) {
        throw new BadRequestException('Inconsistent primary-key shape across rows');
      }
    }
    const tuples = pks.map(() => `(${firstKeys.map(() => '?').join(', ')})`).join(', ');
    const params: unknown[] = [];
    for (const pk of pks) for (const k of firstKeys) params.push(pk[k]);
    const cols2 = firstKeys.map(quoteSqlite).join(', ');
    try {
      const r = this.db
        .prepare(`DELETE FROM ${quoteSqlite(table)} WHERE (${cols2}) IN (${tuples})`)
        .run(...(params as any[]));
      return r.changes;
    } catch (err) {
      throw toDriverHttpError(err);
    }
  }

  async getTableDefinition(_schema: string, table: string): Promise<string> {
    const r = this.db
      .prepare(`SELECT sql FROM sqlite_master WHERE type IN ('table','view') AND name = ?`)
      .get(table) as any;
    if (!r?.sql) throw new BadRequestException(`Unknown table ${table}`);
    let out: string = r.sql + ';';
    // Append indexes & triggers, matching the other drivers' output style.
    const extras = this.db
      .prepare(`SELECT sql FROM sqlite_master WHERE type IN ('index','trigger') AND tbl_name = ? AND sql IS NOT NULL ORDER BY type, name`)
      .all(table) as any[];
    for (const e of extras) out += '\n\n' + e.sql + ';';
    return out;
  }

  async runRawQuery(sql: string, params: unknown[] = []): Promise<QueryResult> {
    const start = Date.now();
    const stmt = this.db.prepare(sql);
    const cmd = sql.trim().split(/\s+/)[0]?.toUpperCase();
    if ((stmt as any).reader) {
      const rows = stmt.all(...(params as any[])) as any[];
      return { rows, fields: rows[0] ? Object.keys(rows[0]).map((n) => ({ name: n })) : [], rowCount: rows.length, command: cmd, durationMs: Date.now() - start };
    } else {
      const r = stmt.run(...(params as any[]));
      return { rows: [], fields: [], rowCount: r.changes, command: cmd, durationMs: Date.now() - start };
    }
  }

  async introspectForER(): Promise<ErDiagram> {
    const tables = await this.listTables();
    const out: ErDiagram = { tables: [], foreignKeys: [] };
    for (const t of tables) {
      out.tables.push({ schema: 'main', name: t.name, columns: await this.getTableColumns('main', t.name) });
      const fks = this.db.prepare(`PRAGMA foreign_key_list(${quoteSqlite(t.name)})`).all() as any[];
      const grouped = new Map<number, any>();
      for (const f of fks) {
        if (!grouped.has(f.id)) grouped.set(f.id, {
          name: `fk_${t.name}_${f.id}`, schema: 'main', table: t.name, columns: [],
          refSchema: 'main', refTable: f.table, refColumns: [],
          onDelete: f.on_delete, onUpdate: f.on_update,
        });
        grouped.get(f.id).columns.push(f.from); grouped.get(f.id).refColumns.push(f.to);
      }
      out.foreignKeys.push(...grouped.values());
    }
    return out;
  }

  async listFunctions(): Promise<FunctionMeta[]> { return []; }

  async listTriggers(): Promise<TriggerMeta[]> {
    const rows = this.db.prepare(`SELECT name, tbl_name, sql FROM sqlite_master WHERE type='trigger'`).all() as any[];
    return rows.map((r) => ({ schema: 'main', table: r.tbl_name, name: r.name, statement: r.sql }));
  }

  async listIndexes(_s?: string, table?: string): Promise<IndexMeta[]> {
    const tables = table ? [{ name: table }] : (await this.listTables());
    const out: IndexMeta[] = [];
    for (const t of tables) {
      const idxs = this.db.prepare(`PRAGMA index_list(${quoteSqlite(t.name)})`).all() as any[];
      for (const i of idxs) {
        const cols = this.db.prepare(`PRAGMA index_info(${quoteSqlite(i.name)})`).all() as any[];
        out.push({
          name: i.name, schema: 'main', table: t.name,
          columns: cols.map((c) => c.name), isUnique: !!i.unique,
          isPrimary: i.origin === 'pk',
        });
      }
    }
    return out;
  }

  async createTable(spec: CreateTableSpec, execute: boolean) {
    const colDefs = spec.columns.map((c) => this.colDefinition(c));
    const fks = (spec.foreignKeys ?? []).map((fk) => this.fkClause(fk));
    const sql = `CREATE TABLE ${quoteSqlite(spec.name)} (\n  ${[...colDefs, ...fks].join(',\n  ')}\n)`;
    if (execute) {
      try {
        this.db.exec(sql);
      } catch (err) {
        throw toDriverHttpError(err);
      }
    }
    return { sql, executed: execute };
  }

  async alterTable(spec: AlterTableSpec, execute: boolean) {
    // SQLite's ALTER is famously limited — ADD COLUMN / RENAME COLUMN / RENAME TO
    // and (since 3.35) DROP COLUMN are supported. CHECK / FK additions on existing
    // tables require a full table rewrite, which we don't attempt here.
    const stmts: string[] = [];
    for (const c of spec.addColumns ?? []) {
      // Inline column definition — SQLite's ADD COLUMN accepts PK? UNIQUE? etc.
      stmts.push(`ALTER TABLE ${quoteSqlite(spec.name)} ADD COLUMN ${this.colDefinition(c)}`);
    }
    for (const r of spec.renameColumns ?? [])
      stmts.push(`ALTER TABLE ${quoteSqlite(spec.name)} RENAME COLUMN ${quoteSqlite(r.from)} TO ${quoteSqlite(r.to)}`);
    for (const n of spec.dropColumns ?? [])
      stmts.push(`ALTER TABLE ${quoteSqlite(spec.name)} DROP COLUMN ${quoteSqlite(n)}`);
    if (spec.renameTo) stmts.push(`ALTER TABLE ${quoteSqlite(spec.name)} RENAME TO ${quoteSqlite(spec.renameTo)}`);
    if ((spec.addForeignKeys?.length ?? 0) > 0 || (spec.dropConstraints?.length ?? 0) > 0 || (spec.alterColumns?.length ?? 0) > 0) {
      throw new BadRequestException(
        'SQLite does not support altering column types, dropping constraints, or adding foreign keys on an existing table. Rebuild the table manually.',
      );
    }
    const sql = stmts.join(';\n') + (stmts.length ? ';' : '');
    if (execute && stmts.length) {
      try {
        for (const s of stmts) this.db.exec(s);
      } catch (err) {
        throw toDriverHttpError(err);
      }
    }
    return { sql, executed: execute && stmts.length > 0 };
  }

  async dropTable(_s: string, table: string, execute: boolean) {
    const sql = `DROP TABLE ${quoteSqlite(table)}`;
    if (execute) this.db.exec(sql);
    return { sql, executed: execute };
  }

  async close() { this.db.close(); }
}
