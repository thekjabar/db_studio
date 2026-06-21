import { BadRequestException } from '@nestjs/common';
import { Pool, PoolClient, types } from 'pg';
import { Dialect } from '@prisma/client';
import {
  AlterTableSpec,
  ColumnMeta,
  ColumnSpec,
  ConnectionCredentials,
  CreateTableSpec,
  DriverOptions,
  ErDiagram,
  ForeignKeySpec,
  FunctionMeta,
  IDatabaseDriver,
  IndexMeta,
  QueryResult,
  TableDataQuery,
  TableDataResult,
  TableRef,
  TriggerMeta,
} from './driver.interface';
import { assertCheckExpr, assertDefaultExpr, assertFkAction, assertSqlType, quotePg, whitelistIdent } from './quote.util';
import { toDriverHttpError } from './driver-errors';

// Return BIGINT as string to preserve precision.
types.setTypeParser(20, (v) => v);

const ALLOWED_FILTER_OPS = new Set(['=', '!=', '<', '<=', '>', '>=', 'like', 'ilike', 'is null', 'is not null', 'in']);

export class PostgresDriver implements IDatabaseDriver {
  readonly dialect = Dialect.POSTGRES;
  private pool: Pool;
  private readonly timeoutMs: number;
  private readonly readOnly: boolean;

  constructor(creds: ConnectionCredentials, opts: DriverOptions = {}) {
    this.pool = new Pool({
      host: creds.host,
      port: creds.port ?? 5432,
      user: creds.user,
      password: creds.password,
      database: creds.database,
      ssl:
        creds.sslMode && creds.sslMode !== 'disable'
          ? { rejectUnauthorized: creds.sslMode === 'verify-full' }
          : undefined,
      max: 5,
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
    });
    this.timeoutMs = opts.statementTimeoutMs ?? 30_000;
    this.readOnly = !!opts.readOnly;
    // Pool emits errors on idle clients (e.g. server kills the connection).
    // Without a listener, the process would crash on an unhandled 'error' event.
    this.pool.on('error', () => {});
  }

  private async withClient<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    let client: PoolClient;
    try {
      client = await this.pool.connect();
    } catch (err) {
      throw toDriverHttpError(err);
    }
    try {
      await client.query(`SET statement_timeout = ${Number(this.timeoutMs)}`);
      if (this.readOnly) {
        await client.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');
      }
      return await fn(client);
    } catch (err) {
      throw toDriverHttpError(err);
    } finally {
      client.release();
    }
  }

  private async poolQuery(text: string, params?: unknown[]) {
    try {
      return await this.pool.query(text, params as never);
    } catch (err) {
      throw toDriverHttpError(err);
    }
  }

  async testConnection() {
    try {
      const r = await this.pool.query('SELECT version() as v');
      return { ok: true, version: r.rows[0]?.v };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  async listSchemas(): Promise<string[]> {
    const r = await this.poolQuery(
      `SELECT schema_name FROM information_schema.schemata
       WHERE schema_name NOT IN ('pg_catalog','information_schema')
         AND schema_name NOT LIKE 'pg_toast%' AND schema_name NOT LIKE 'pg_temp%'
       ORDER BY schema_name`,
    );
    return r.rows.map((x) => x.schema_name as string);
  }

  async listTables(schema?: string): Promise<TableRef[]> {
    const r = await this.poolQuery(
      `SELECT n.nspname AS schema, c.relname AS name,
              CASE c.relkind WHEN 'r' THEN 'table' WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized_view' END AS type,
              obj_description(c.oid) AS comment,
              c.reltuples::bigint AS est_rows
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r','v','m')
          AND n.nspname NOT IN ('pg_catalog','information_schema')
          AND ($1::text IS NULL OR n.nspname = $1)
        ORDER BY n.nspname, c.relname`,
      [schema ?? null],
    );
    return r.rows.map((x) => ({
      schema: x.schema,
      name: x.name,
      type: x.type,
      comment: x.comment,
      estimatedRows: x.est_rows ? Number(x.est_rows) : null,
    }));
  }

  async getTableColumns(schema: string, table: string): Promise<ColumnMeta[]> {
    const r = await this.poolQuery(
      `SELECT
          c.column_name AS name,
          c.data_type AS data_type,
          (c.is_nullable = 'YES') AS nullable,
          c.column_default AS default_value,
          c.character_maximum_length AS char_max,
          c.numeric_precision AS num_prec,
          c.numeric_scale AS num_scale,
          c.is_identity = 'YES' AS is_identity,
          COALESCE(pk.is_pk, false) AS is_pk,
          COALESCE(uq.is_unique, false) AS is_unique,
          pgd.description AS comment
         FROM information_schema.columns c
    LEFT JOIN (
        SELECT kcu.column_name, true AS is_pk
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
         WHERE tc.constraint_type = 'PRIMARY KEY'
           AND tc.table_schema = $1 AND tc.table_name = $2
    ) pk ON pk.column_name = c.column_name
    LEFT JOIN (
        SELECT kcu.column_name, true AS is_unique
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
         WHERE tc.constraint_type = 'UNIQUE'
           AND tc.table_schema = $1 AND tc.table_name = $2
    ) uq ON uq.column_name = c.column_name
    LEFT JOIN pg_catalog.pg_statio_all_tables st
           ON st.schemaname = c.table_schema AND st.relname = c.table_name
    LEFT JOIN pg_catalog.pg_description pgd
           ON pgd.objoid = st.relid AND pgd.objsubid = c.ordinal_position
        WHERE c.table_schema = $1 AND c.table_name = $2
        ORDER BY c.ordinal_position`,
      [schema, table],
    );
    return r.rows.map((x) => ({
      name: x.name,
      dataType: x.data_type,
      nullable: x.nullable,
      defaultValue: x.default_value,
      isPrimaryKey: x.is_pk,
      isUnique: x.is_unique,
      isIdentity: x.is_identity,
      comment: x.comment,
      charMaxLength: x.char_max,
      numericPrecision: x.num_prec,
      numericScale: x.num_scale,
    }));
  }

  private async validateSchemaTable(schema: string, table: string): Promise<void> {
    const r = await this.poolQuery(
      `SELECT 1 FROM information_schema.tables WHERE table_schema=$1 AND table_name=$2`,
      [schema, table],
    );
    if (!r.rowCount) throw new BadRequestException(`Unknown table ${schema}.${table}`);
  }

  async getTableData(q: TableDataQuery): Promise<TableDataResult> {
    const cols = await this.getTableColumns(q.schema, q.table);
    if (!cols.length) throw new Error(`No such table ${q.schema}.${q.table}`);
    const colNames = new Set(cols.map((c) => c.name));

    const fqtn = `${quotePg(q.schema)}.${quotePg(q.table)}`;
    const where: string[] = [];
    const params: unknown[] = [];
    for (const f of q.filters ?? []) {
      whitelistIdent(f.column, colNames);
      const op = f.op.toLowerCase();
      if (!ALLOWED_FILTER_OPS.has(op)) throw new Error(`Disallowed filter op ${op}`);
      if (op === 'is null' || op === 'is not null') {
        where.push(`${quotePg(f.column)} ${op.toUpperCase()}`);
      } else if (op === 'in' && Array.isArray(f.value)) {
        const placeholders = f.value.map(() => `$${params.length + 1 + params.length}`);
        // simpler: push each value
        const start = params.length + 1;
        f.value.forEach((v) => params.push(v));
        const ph = f.value.map((_, i) => `$${start + i}`).join(',');
        where.push(`${quotePg(f.column)} IN (${ph})`);
        void placeholders;
      } else {
        params.push(f.value);
        where.push(`${quotePg(f.column)} ${op.toUpperCase()} $${params.length}`);
      }
    }
    // extraPredicate: pre-validated row-level filter. Wrapped in parens so
    // OR inside it can't tear into user filters. Appended after user filters
    // so EXPLAIN / error messages point at the user's choices first.
    if (q.extraPredicate && q.extraPredicate.trim()) {
      where.push(`(${q.extraPredicate})`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const orderSql = (q.orderBy ?? [])
      .map((o) => {
        whitelistIdent(o.column, colNames);
        return `${quotePg(o.column)} ${o.direction === 'desc' ? 'DESC' : 'ASC'}`;
      })
      .join(', ');

    return this.withClient(async (client) => {
      const limit = Math.max(1, Math.min(q.limit, 1000));
      const offset = Math.max(0, q.offset);

      // Cheap pagination:
      //   - No filters: use pg_class.reltuples (instant, approximate).
      //   - With filters: run exact count only when the estimate is small
      //     (EXACT_COUNT_THRESHOLD). Otherwise return null so the UI shows
      //     "N+ rows" and hides the jump-to-last-page affordance.
      const EXACT_COUNT_THRESHOLD = 50_000;

      // reltuples for the base table — cast to bigint to avoid float rounding.
      // We need the OID for `$schema.$table`. `::regclass` folds unquoted
      // identifiers to lowercase, so a MixedCase table like "User" resolves
      // to the nonexistent "user" and throws. We look it up via catalog
      // JOIN instead — exact match on name, no case-folding, safe for any
      // identifier. `reltuples = -1` means the table was never analyzed;
      // we treat that as "unknown → tiny" so we fall into the exact-count
      // branch and return real numbers.
      const estRes = await client.query(
        `SELECT GREATEST(0, c.reltuples)::bigint AS est
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relname = $2`,
        [q.schema, q.table],
      );
      const estimate = Number(estRes.rows[0]?.est ?? 0);

      let total: number | null;
      let totalIsEstimate = false;
      if (!where.length) {
        // Exact for small tables (estimate is reliable after ANALYZE), otherwise estimate.
        if (estimate < EXACT_COUNT_THRESHOLD) {
          const r = await client.query(`SELECT count(*)::bigint AS c FROM ${fqtn}`);
          total = Number(r.rows[0].c);
        } else {
          total = estimate;
          totalIsEstimate = true;
        }
      } else if (estimate < EXACT_COUNT_THRESHOLD) {
        const r = await client.query(
          `SELECT count(*)::bigint AS c FROM ${fqtn} ${whereSql}`,
          params,
        );
        total = Number(r.rows[0].c);
      } else {
        // Skip exact count on large filtered sets — can be multi-second on 10M rows.
        total = null;
      }

      const sql = `SELECT * FROM ${fqtn} ${whereSql} ${orderSql ? `ORDER BY ${orderSql}` : ''} LIMIT ${limit} OFFSET ${offset}`;
      const res = await client.query(sql, params);
      return { columns: cols, rows: res.rows, total, totalIsEstimate };
    });
  }

  async insertRow(schema: string, table: string, values: Record<string, unknown>) {
    const cols = await this.getTableColumns(schema, table);
    const allowed = new Set(cols.map((c) => c.name));
    const keys = Object.keys(values).filter((k) => allowed.has(k));
    const fqtn = `${quotePg(schema)}.${quotePg(table)}`;
    if (!keys.length) {
      // All columns rely on defaults / identity — use DEFAULT VALUES.
      const sql = `INSERT INTO ${fqtn} DEFAULT VALUES RETURNING *`;
      const r = await this.withClient((c) => c.query(sql));
      return r.rows[0];
    }
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(',');
    const colList = keys.map(quotePg).join(',');
    const sql = `INSERT INTO ${fqtn} (${colList}) VALUES (${placeholders}) RETURNING *`;
    const r = await this.withClient((c) => c.query(sql, keys.map((k) => values[k])));
    return r.rows[0];
  }

  async updateRow(schema: string, table: string, pk: Record<string, unknown>, values: Record<string, unknown>) {
    const cols = await this.getTableColumns(schema, table);
    const allowed = new Set(cols.map((c) => c.name));
    const setKeys = Object.keys(values).filter((k) => allowed.has(k));
    const pkKeys = Object.keys(pk).filter((k) => allowed.has(k));
    if (!setKeys.length) throw new BadRequestException('No valid columns to update');
    if (!pkKeys.length) throw new BadRequestException('Primary key required');
    const params: unknown[] = [];
    const setSql = setKeys.map((k) => {
      params.push(values[k]);
      return `${quotePg(k)} = $${params.length}`;
    }).join(', ');
    const whereSql = pkKeys.map((k) => {
      params.push(pk[k]);
      return `${quotePg(k)} = $${params.length}`;
    }).join(' AND ');
    const sql = `UPDATE ${quotePg(schema)}.${quotePg(table)} SET ${setSql} WHERE ${whereSql} RETURNING *`;
    const r = await this.withClient((c) => c.query(sql, params));
    if (!r.rowCount) throw new Error('Row not found');
    return r.rows[0];
  }

  async deleteRow(schema: string, table: string, pk: Record<string, unknown>) {
    const cols = await this.getTableColumns(schema, table);
    const allowed = new Set(cols.map((c) => c.name));
    const pkKeys = Object.keys(pk).filter((k) => allowed.has(k));
    if (!pkKeys.length) throw new BadRequestException('Primary key required');
    const params: unknown[] = [];
    const whereSql = pkKeys.map((k) => {
      params.push(pk[k]);
      return `${quotePg(k)} = $${params.length}`;
    }).join(' AND ');
    const sql = `DELETE FROM ${quotePg(schema)}.${quotePg(table)} WHERE ${whereSql}`;
    const r = await this.withClient((c) => c.query(sql, params));
    return r.rowCount ?? 0;
  }

  async fetchRowByPk(schema: string, table: string, pk: Record<string, unknown>) {
    const cols = await this.getTableColumns(schema, table);
    const allowed = new Set(cols.map((c) => c.name));
    const keys = Object.keys(pk).filter((k) => allowed.has(k));
    if (!keys.length) throw new BadRequestException('Primary key required');
    const params: unknown[] = [];
    const whereSql = keys.map((k) => {
      params.push(pk[k]);
      return `${quotePg(k)} = $${params.length}`;
    }).join(' AND ');
    const r = await this.poolQuery(
      `SELECT * FROM ${quotePg(schema)}.${quotePg(table)} WHERE ${whereSql} LIMIT 1`,
      params,
    );
    return r.rows[0] ?? null;
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
        return `$${params.length}`;
      });
      return `(${ph.join(', ')})`;
    });
    const cols2 = firstKeys.map(quotePg).join(', ');
    const r = await this.poolQuery(
      `SELECT * FROM ${quotePg(schema)}.${quotePg(table)} WHERE (${cols2}) IN (${tuples.join(', ')})`,
      params,
    );
    return r.rows;
  }

  async deleteRows(schema: string, table: string, pks: Record<string, unknown>[]) {
    if (!pks.length) return 0;
    const cols = await this.getTableColumns(schema, table);
    const allowed = new Set(cols.map((c) => c.name));
    const firstKeys = Object.keys(pks[0]).filter((k) => allowed.has(k));
    if (!firstKeys.length) throw new BadRequestException('Primary key required');
    // All rows must share the same PK shape.
    for (const pk of pks) {
      const ks = Object.keys(pk).filter((k) => allowed.has(k));
      if (ks.length !== firstKeys.length || firstKeys.some((k) => !ks.includes(k))) {
        throw new BadRequestException('Inconsistent primary-key shape across rows');
      }
    }
    // DELETE ... WHERE (pk1, pk2) IN ((v11, v12), (v21, v22), ...)
    const params: unknown[] = [];
    const tuples = pks.map((pk) => {
      const ph = firstKeys.map((k) => {
        params.push(pk[k]);
        return `$${params.length}`;
      });
      return `(${ph.join(', ')})`;
    });
    const cols2 = firstKeys.map(quotePg).join(', ');
    const sql = `DELETE FROM ${quotePg(schema)}.${quotePg(table)} WHERE (${cols2}) IN (${tuples.join(', ')})`;
    const r = await this.withClient((c) => c.query(sql, params));
    return r.rowCount ?? 0;
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
    // UPDATE ... SET col1 = $1, col2 = $2 WHERE (pk1, pk2) IN (($3, $4), ...)
    const params: unknown[] = [];
    const setSql = setKeys
      .map((k) => {
        params.push(values[k]);
        return `${quotePg(k)} = $${params.length}`;
      })
      .join(', ');
    const tuples = pks.map((pk) => {
      const ph = firstKeys.map((k) => {
        params.push(pk[k]);
        return `$${params.length}`;
      });
      return `(${ph.join(', ')})`;
    });
    const cols2 = firstKeys.map(quotePg).join(', ');
    const sql = `UPDATE ${quotePg(schema)}.${quotePg(table)} SET ${setSql} WHERE (${cols2}) IN (${tuples.join(', ')})`;
    const r = await this.withClient((c) => c.query(sql, params));
    return r.rowCount ?? 0;
  }

  async runRawQuery(
    sql: string,
    params: unknown[] = [],
    opts?: { searchPath?: string },
  ): Promise<QueryResult> {
    const start = Date.now();
    const r = await this.withClient(async (c) => {
      // Scope unqualified table names by setting search_path on THIS client
      // before the query — must be a separate statement on the same connection
      // (concatenating "SET ...; SELECT ..." makes pg return the SET's empty
      // result instead of the SELECT's rows). Reject quote/semicolon chars.
      if (opts?.searchPath && !/["';\\]/.test(opts.searchPath)) {
        await c.query(`SET search_path TO "${opts.searchPath}"`);
      }
      return c.query(sql, params);
    });
    // node-postgres returns an ARRAY of result objects for a multi-statement
    // string; a single statement returns one object. Normalize to the last
    // result that actually carried rows (the SELECT in "SET ...; SELECT ..."),
    // and always default rows/fields to [] so callers never see undefined.
    const result = Array.isArray(r)
      ? ([...r].reverse().find((x) => Array.isArray(x?.rows) && x.rows.length > 0) ?? r[r.length - 1] ?? {})
      : r;
    return {
      rows: result.rows ?? [],
      fields: (result.fields ?? []).map((f: { name: string; dataTypeID: number }) => ({
        name: f.name,
        dataType: String(f.dataTypeID),
      })),
      rowCount: result.rowCount ?? 0,
      command: result.command,
      durationMs: Date.now() - start,
    };
  }

  async introspectForER(schema?: string): Promise<ErDiagram> {
    // Read columns + PK/unique flags straight from pg_catalog. The previous
    // information_schema version used two LATERAL joins against
    // table_constraints/key_column_usage, which Postgres re-evaluates per column
    // and dominated the latency on remote DBs (9s+ on 120 tables). This catalog
    // query joins pg_attribute once and resolves PK/unique with a single pass
    // over pg_index.
    const t0 = Date.now();
    const colsRes = await this.poolQuery(
      `SELECT
          n.nspname       AS schema,
          cls.relname     AS "table",
          a.attname       AS name,
          format_type(a.atttypid, a.atttypmod) AS data_type,
          NOT a.attnotnull AS nullable,
          pg_get_expr(ad.adbin, ad.adrelid) AS default_value,
          CASE
            WHEN a.atttypid IN (1042, 1043) AND a.atttypmod >= 0 THEN a.atttypmod - 4
          END AS char_max,
          information_schema._pg_numeric_precision(a.atttypid, a.atttypmod) AS num_prec,
          information_schema._pg_numeric_scale(a.atttypid, a.atttypmod) AS num_scale,
          a.attidentity <> ''     AS is_identity,
          COALESCE(pk.is_pk, false)   AS is_pk,
          COALESCE(uq.is_unique, false) AS is_unique,
          a.attnum AS ord
         FROM pg_class cls
         JOIN pg_namespace n ON n.oid = cls.relnamespace
         JOIN pg_attribute a ON a.attrelid = cls.oid AND a.attnum > 0 AND NOT a.attisdropped
    LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
    LEFT JOIN LATERAL (
           SELECT true AS is_pk
             FROM pg_index i
            WHERE i.indrelid = cls.oid
              AND i.indisprimary
              AND a.attnum = ANY(i.indkey)
            LIMIT 1
         ) pk ON true
    LEFT JOIN LATERAL (
           SELECT true AS is_unique
             FROM pg_index i
            WHERE i.indrelid = cls.oid
              AND i.indisunique
              AND NOT i.indisprimary
              AND a.attnum = ANY(i.indkey)
              AND array_length(i.indkey::int[], 1) = 1
            LIMIT 1
         ) uq ON true
        WHERE cls.relkind IN ('r','v','m','p')
          AND n.nspname NOT IN ('pg_catalog','information_schema')
          AND ($1::text IS NULL OR n.nspname = $1)
        ORDER BY n.nspname, cls.relname, a.attnum`,
      [schema ?? null],
    );

    const byTable = new Map<string, { schema: string; name: string; columns: ColumnMeta[] }>();
    for (const r of colsRes.rows) {
      const key = `${r.schema}.${r.table}`;
      let entry = byTable.get(key);
      if (!entry) {
        entry = { schema: r.schema, name: r.table, columns: [] };
        byTable.set(key, entry);
      }
      entry.columns.push({
        name: r.name,
        dataType: r.data_type,
        nullable: r.nullable,
        defaultValue: r.default_value,
        isPrimaryKey: r.is_pk,
        isUnique: r.is_unique,
        isIdentity: r.is_identity,
        charMaxLength: r.char_max,
        numericPrecision: r.num_prec,
        numericScale: r.num_scale,
      });
    }
    const out: ErDiagram = { tables: Array.from(byTable.values()), foreignKeys: [] };
    const tCols = Date.now();
    // FKs from pg_constraint — reading pg_catalog directly beats the
    // information_schema.referential_constraints view on remote DBs.
    const fkRes = await this.poolQuery(
      `SELECT
          con.conname AS name,
          n.nspname   AS schema,
          cls.relname AS "table",
          (
            SELECT array_agg(att.attname ORDER BY ord.pos)
              FROM unnest(con.conkey) WITH ORDINALITY AS ord(col, pos)
              JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = ord.col
          ) AS columns,
          rn.nspname  AS ref_schema,
          rcls.relname AS ref_table,
          (
            SELECT array_agg(att.attname ORDER BY ord.pos)
              FROM unnest(con.confkey) WITH ORDINALITY AS ord(col, pos)
              JOIN pg_attribute att ON att.attrelid = con.confrelid AND att.attnum = ord.col
          ) AS ref_columns,
          CASE con.confdeltype
            WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT'
            WHEN 'c' THEN 'CASCADE'   WHEN 'n' THEN 'SET NULL'
            WHEN 'd' THEN 'SET DEFAULT' END AS on_delete,
          CASE con.confupdtype
            WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT'
            WHEN 'c' THEN 'CASCADE'   WHEN 'n' THEN 'SET NULL'
            WHEN 'd' THEN 'SET DEFAULT' END AS on_update
         FROM pg_constraint con
         JOIN pg_class cls     ON cls.oid  = con.conrelid
         JOIN pg_namespace n   ON n.oid    = cls.relnamespace
         JOIN pg_class rcls    ON rcls.oid = con.confrelid
         JOIN pg_namespace rn  ON rn.oid   = rcls.relnamespace
        WHERE con.contype = 'f'
          AND n.nspname NOT IN ('pg_catalog','information_schema')
          AND ($1::text IS NULL OR n.nspname = $1)`,
      [schema ?? null],
    );
    const tFks = Date.now();
    // `array_agg(...)` inside a scalar subquery is returned by node-postgres
    // as a string literal (e.g. `{id,user_id}`) rather than a JS array,
    // because the subquery has no registered array OID. Normalize here so
    // downstream code can always rely on real arrays.
    const toStrArray = (v: unknown): string[] => {
      if (Array.isArray(v)) return v.map(String);
      if (typeof v === 'string') {
        const inner = v.replace(/^\{|\}$/g, '').trim();
        if (!inner) return [];
        return inner.split(',').map((s) => s.replace(/^"|"$/g, ''));
      }
      return [];
    };
    out.foreignKeys = fkRes.rows.map((x) => ({
      name: x.name,
      schema: x.schema,
      table: x.table,
      columns: toStrArray(x.columns),
      refSchema: x.ref_schema,
      refTable: x.ref_table,
      refColumns: toStrArray(x.ref_columns),
      onDelete: x.on_delete,
      onUpdate: x.on_update,
    }));
    console.log(
      `[ER:pg] cols=${tCols - t0}ms fks=${tFks - tCols}ms rows(cols)=${colsRes.rows.length} rows(fks)=${fkRes.rows.length}`,
    );
    return out;
  }

  async listFunctions(schema?: string): Promise<FunctionMeta[]> {
    const r = await this.poolQuery(
      `SELECT n.nspname AS schema, p.proname AS name, l.lanname AS language,
              pg_get_function_result(p.oid) AS ret,
              pg_get_function_arguments(p.oid) AS args
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         JOIN pg_language l ON l.oid = p.prolang
        WHERE n.nspname NOT IN ('pg_catalog','information_schema')
          AND ($1::text IS NULL OR n.nspname = $1)
        ORDER BY n.nspname, p.proname`,
      [schema ?? null],
    );
    return r.rows.map((x) => ({ schema: x.schema, name: x.name, language: x.language, returnType: x.ret, arguments: x.args }));
  }

  async listTriggers(schema?: string): Promise<TriggerMeta[]> {
    const r = await this.poolQuery(
      `SELECT trigger_schema AS schema, event_object_table AS table, trigger_name AS name,
              action_timing AS timing, event_manipulation AS event, action_statement AS statement
         FROM information_schema.triggers
        WHERE ($1::text IS NULL OR trigger_schema = $1)
        ORDER BY trigger_schema, event_object_table, trigger_name`,
      [schema ?? null],
    );
    return r.rows as TriggerMeta[];
  }

  async listIndexes(schema?: string, table?: string): Promise<IndexMeta[]> {
    const r = await this.poolQuery(
      `SELECT n.nspname AS schema, c.relname AS table, i.relname AS name,
              ix.indisunique AS is_unique, ix.indisprimary AS is_primary,
              am.amname AS method,
              array_agg(a.attname ORDER BY k.ordinality) AS columns
         FROM pg_index ix
         JOIN pg_class c ON c.oid = ix.indrelid
         JOIN pg_class i ON i.oid = ix.indexrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_am am ON am.oid = i.relam
         JOIN unnest(ix.indkey) WITH ORDINALITY k(attnum, ordinality) ON true
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
        WHERE n.nspname NOT IN ('pg_catalog','information_schema')
          AND ($1::text IS NULL OR n.nspname = $1)
          AND ($2::text IS NULL OR c.relname = $2)
        GROUP BY n.nspname, c.relname, i.relname, ix.indisunique, ix.indisprimary, am.amname
        ORDER BY n.nspname, c.relname, i.relname`,
      [schema ?? null, table ?? null],
    );
    return r.rows.map((x) => ({
      name: x.name, schema: x.schema, table: x.table,
      columns: x.columns, isUnique: x.is_unique, isPrimary: x.is_primary, method: x.method,
    }));
  }

  async getTableDefinition(schema: string, table: string): Promise<string> {
    // Columns
    const colsRes = await this.poolQuery(
      `SELECT
         a.attname AS name,
         pg_catalog.format_type(a.atttypid, a.atttypmod) AS type,
         NOT a.attnotnull AS nullable,
         pg_catalog.pg_get_expr(ad.adbin, ad.adrelid) AS default_expr,
         a.attnum AS ord
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
       WHERE n.nspname = $1 AND c.relname = $2
         AND a.attnum > 0 AND NOT a.attisdropped
       ORDER BY a.attnum`,
      [schema, table],
    );
    if (!colsRes.rowCount) {
      throw new BadRequestException(`Unknown table ${schema}.${table}`);
    }

    // Table-level constraints (pk, uq, fk, check)
    const consRes = await this.poolQuery(
      `SELECT con.conname AS name, con.contype AS type,
              pg_catalog.pg_get_constraintdef(con.oid, true) AS def
         FROM pg_constraint con
         JOIN pg_class c ON c.oid = con.conrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = $2
        ORDER BY con.contype DESC, con.conname`,
      [schema, table],
    );

    // Tablespace
    const tsRes = await this.poolQuery(
      `SELECT COALESCE(t.spcname, 'pg_default') AS ts
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_tablespace t ON t.oid = c.reltablespace
        WHERE n.nspname = $1 AND c.relname = $2`,
      [schema, table],
    );
    const tablespace: string = tsRes.rows[0]?.ts ?? 'pg_default';

    // Indexes (skip those backing a unique/pk constraint — those are already emitted as constraints)
    const idxRes = await this.poolQuery(
      `SELECT i.relname AS name,
              pg_catalog.pg_get_indexdef(ix.indexrelid, 0, true) AS def,
              con.conname IS NOT NULL AS is_constraint
         FROM pg_index ix
         JOIN pg_class c ON c.oid = ix.indrelid
         JOIN pg_class i ON i.oid = ix.indexrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_constraint con ON con.conindid = ix.indexrelid
        WHERE n.nspname = $1 AND c.relname = $2
        ORDER BY i.relname`,
      [schema, table],
    );

    // Triggers (skip internal FK/constraint triggers)
    const trigRes = await this.poolQuery(
      `SELECT tg.tgname AS name,
              pg_catalog.pg_get_triggerdef(tg.oid, true) AS def
         FROM pg_trigger tg
         JOIN pg_class c ON c.oid = tg.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = $2
          AND NOT tg.tgisinternal
        ORDER BY tg.tgname`,
      [schema, table],
    );

    const qualified = `${quotePg(schema)}.${quotePg(table)}`;
    const lines: string[] = [`CREATE TABLE ${qualified} (`];

    const colLines = colsRes.rows.map((c: { name: string; type: string; nullable: boolean; default_expr: string | null }) => {
      let s = `  ${quotePg(c.name)} ${c.type}`;
      if (!c.nullable) s += ' NOT NULL';
      else s += ' NULL';
      if (c.default_expr) s += ` DEFAULT ${c.default_expr}`;
      return s;
    });

    const consLines = consRes.rows.map((x: { name: string; def: string }) => `  CONSTRAINT ${quotePg(x.name)} ${x.def}`);

    lines.push([...colLines, ...consLines].join(',\n'));
    lines.push(`) TABLESPACE ${tablespace};`);

    let out = lines.join('\n');

    // Non-constraint indexes
    const idxDefs = idxRes.rows
      .filter((x: { is_constraint: boolean }) => !x.is_constraint)
      .map((x: { def: string }) => `${x.def};`);
    if (idxDefs.length) out += '\n\n' + idxDefs.join('\n\n');

    // Triggers
    if (trigRes.rowCount) {
      out += '\n\n' + trigRes.rows.map((x: { def: string }) => `${x.def};`).join('\n\n');
    }

    return out;
  }

  private renderDefault(c: { default?: string | null; defaultIsExpression?: boolean }): string | null {
    if (c.default == null || c.default === '') return null;
    const safe = assertDefaultExpr(c.default);
    return c.defaultIsExpression ? `(${safe})` : safe;
  }

  private colDefinition(c: ColumnSpec): string {
    const parts = [quotePg(c.name), assertSqlType(c.type)];
    if (c.primaryKey) parts.push('PRIMARY KEY');
    if (c.unique) parts.push('UNIQUE');
    if (c.nullable === false) parts.push('NOT NULL');
    const dv = this.renderDefault(c);
    if (dv != null) parts.push(`DEFAULT ${dv}`);
    if (c.check) parts.push(`CHECK (${assertCheckExpr(c.check)})`);
    return parts.join(' ');
  }

  private fkClause(spec: CreateTableSpec | AlterTableSpec, fk: ForeignKeySpec): string {
    const refs = fk.refColumns.map(quotePg).join(', ');
    const cols = fk.columns.map(quotePg).join(', ');
    const refTbl = `${quotePg(fk.refSchema ?? spec.schema)}.${quotePg(fk.refTable)}`;
    let s = `FOREIGN KEY (${cols}) REFERENCES ${refTbl} (${refs})`;
    const onDel = assertFkAction(fk.onDelete);
    const onUpd = assertFkAction(fk.onUpdate);
    if (onDel) s += ` ON DELETE ${onDel}`;
    if (onUpd) s += ` ON UPDATE ${onUpd}`;
    return s;
  }

  async createTable(spec: CreateTableSpec, execute: boolean) {
    const colDefs = spec.columns.map((c) => this.colDefinition(c));
    const fks = (spec.foreignKeys ?? []).map((fk) => this.fkClause(spec, fk));
    const qualified = `${quotePg(spec.schema)}.${quotePg(spec.name)}`;
    const main = `CREATE TABLE ${qualified} (\n  ${[...colDefs, ...fks].join(',\n  ')}\n)`;

    const comments = spec.columns
      .filter((c) => c.comment)
      .map((c) => `COMMENT ON COLUMN ${qualified}.${quotePg(c.name)} IS ${this.quoteLiteral(c.comment!)}`);
    const stmts = [main, ...comments];

    const sql = stmts.join(';\n') + ';';
    if (execute) {
      await this.withClient(async (c) => { for (const s of stmts) await c.query(s); });
    }
    return { sql, executed: execute };
  }

  async alterTable(spec: AlterTableSpec, execute: boolean) {
    await this.validateSchemaTable(spec.schema, spec.name);
    const qualified = `${quotePg(spec.schema)}.${quotePg(spec.name)}`;
    const base = `ALTER TABLE ${qualified}`;
    const parts: string[] = [];

    for (const c of spec.addColumns ?? []) {
      parts.push(`ADD COLUMN ${this.colDefinition(c)}`);
    }
    for (const name of spec.dropColumns ?? []) parts.push(`DROP COLUMN ${quotePg(name)}`);
    for (const name of spec.dropConstraints ?? []) parts.push(`DROP CONSTRAINT ${quotePg(name)}`);
    for (const r of spec.renameColumns ?? []) parts.push(`RENAME COLUMN ${quotePg(r.from)} TO ${quotePg(r.to)}`);
    for (const a of spec.alterColumns ?? []) {
      if (a.type) parts.push(`ALTER COLUMN ${quotePg(a.name)} TYPE ${assertSqlType(a.type)}`);
      if (a.nullable === true) parts.push(`ALTER COLUMN ${quotePg(a.name)} DROP NOT NULL`);
      if (a.nullable === false) parts.push(`ALTER COLUMN ${quotePg(a.name)} SET NOT NULL`);
      if (a.default !== undefined) {
        parts.push(
          a.default === null
            ? `ALTER COLUMN ${quotePg(a.name)} DROP DEFAULT`
            : `ALTER COLUMN ${quotePg(a.name)} SET DEFAULT ${assertDefaultExpr(a.default)}`,
        );
      }
    }
    for (const fk of spec.addForeignKeys ?? []) {
      parts.push(`ADD ${this.fkClause(spec, fk)}`);
    }

    const stmts: string[] = [];
    if (parts.length) stmts.push(`${base} ${parts.join(', ')}`);
    if (spec.renameTo) stmts.push(`${base} RENAME TO ${quotePg(spec.renameTo)}`);

    // Column comments (added columns + alter comments)
    for (const c of spec.addColumns ?? []) {
      if (c.comment) stmts.push(`COMMENT ON COLUMN ${qualified}.${quotePg(c.name)} IS ${this.quoteLiteral(c.comment)}`);
    }
    for (const a of spec.alterColumns ?? []) {
      if (a.comment !== undefined) {
        stmts.push(
          `COMMENT ON COLUMN ${qualified}.${quotePg(a.name)} IS ${
            a.comment === null || a.comment === '' ? 'NULL' : this.quoteLiteral(a.comment)
          }`,
        );
      }
    }

    const sql = stmts.length ? stmts.join(';\n') + ';' : '';
    if (execute && stmts.length) {
      await this.withClient(async (c) => { for (const s of stmts) await c.query(s); });
    }
    return { sql, executed: execute && stmts.length > 0 };
  }

  private quoteLiteral(v: string): string {
    return `'${v.replace(/'/g, "''")}'`;
  }

  async dropTable(schema: string, table: string, execute: boolean) {
    await this.validateSchemaTable(schema, table);
    const sql = `DROP TABLE ${quotePg(schema)}.${quotePg(table)}`;
    if (execute) await this.withClient((c) => c.query(sql));
    return { sql, executed: execute };
  }

  async close() { await this.pool.end(); }
}
