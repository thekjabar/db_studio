import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { DuckDBInstance } from '@duckdb/node-api';
import { Dialect, Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../crypto/crypto.service';
import { RbacService } from '../rbac/rbac.service';
import { ColumnMasksService } from '../connections/column-masks.service';
import { ConnectionCredentials } from '../drivers/driver.interface';

const PURPOSE = (id: string) => `conn:${id}`;
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export interface FederatedSource {
  alias: string;
  connectionId: string;
}

export interface FederatedQueryResult {
  rows: Record<string, unknown>[];
  fields: { name: string; dataType?: string }[];
  rowCount: number;
  durationMs: number;
  truncated: boolean;
  appliedLimit: number | null;
  sources: { alias: string; connectionId: string; dialect: Dialect }[];
}

/** What the distributed planner pushed down to a single remote source. */
export interface SourcePushdown {
  alias: string;
  dialect: Dialect;
  /** The remote table(s) scanned, as DuckDB resolved them. */
  tables: string[];
  /** Filter predicates pushed into the remote scan (run on the source DB). */
  pushedFilters: string[];
  /** Projected columns pushed down — only these are fetched, not SELECT *. */
  projectedColumns: string[];
  /** True when the whole table is pulled with no predicate (a warning sign). */
  fullScan: boolean;
  /** Planner's estimated cardinality for this source's scan, if available. */
  estimatedRows: number | null;
}

export interface FederatedPlan {
  /** Raw DuckDB EXPLAIN text, for power users. */
  raw: string;
  /** Per-source breakdown of what executes remotely vs. what's pulled local. */
  sources: SourcePushdown[];
  /** Cross-source operations DuckDB runs locally (joins, aggregations). */
  localOperations: string[];
  /** Human-readable advisories (e.g. "alias a pulls a full table — add a WHERE"). */
  warnings: string[];
}

/**
 * Runs a federated SQL query across multiple connections using an in-memory
 * DuckDB. Each source is ATTACH'd with a user-picked alias so the caller can
 * reference `alias.schema.table` in their query.
 *
 * Constraints (documented in the UI):
 *  - Postgres / MySQL / SQLite sources only. MSSQL is rejected — DuckDB has
 *    no production-ready MSSQL scanner.
 *  - Caller must have at least VIEWER on every source.
 *  - DuckDB instance is ephemeral — created + destroyed per request.
 *  - Network access runs from the backend, not the browser. SSH-tunnelled
 *    connections are rejected for now (DuckDB extensions connect directly).
 */
@Injectable()
export class FederatedService {
  private readonly log = new Logger(FederatedService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly rbac: RbacService,
    private readonly masks: ColumnMasksService,
  ) {}

  /**
   * Validate + decrypt every source. Shared by runQuery and explainPlan so the
   * RBAC checks and dialect/SSH guards live in exactly one place.
   */
  private async resolveSources(userId: string, sources: FederatedSource[]) {
    if (!Array.isArray(sources) || sources.length === 0) {
      throw new BadRequestException('At least one source is required');
    }
    if (sources.length > 5) {
      throw new BadRequestException('Maximum 5 sources per federated query');
    }
    const usedAliases = new Set<string>();
    const resolved: Array<{ alias: string; connectionId: string; dialect: Dialect; creds: ConnectionCredentials }> = [];
    for (const s of sources) {
      if (!IDENT_RE.test(s.alias)) throw new BadRequestException(`Invalid alias: ${s.alias}`);
      if (usedAliases.has(s.alias)) throw new BadRequestException(`Duplicate alias: ${s.alias}`);
      usedAliases.add(s.alias);
      if (['main', 'pg_catalog', 'information_schema', 'memory', 'system', 'temp'].includes(s.alias)) {
        throw new BadRequestException(`Alias "${s.alias}" is reserved`);
      }
      await this.rbac.require(userId, s.connectionId, Role.VIEWER);
      const conn = await this.prisma.connection.findUnique({
        where: { id: s.connectionId },
        select: { id: true, dialect: true, credentialsCt: true },
      });
      if (!conn) throw new BadRequestException(`Connection ${s.connectionId} not found`);
      if (conn.dialect === Dialect.MSSQL) {
        throw new BadRequestException(
          `Source "${s.alias}" is MSSQL — federated joins against SQL Server aren't supported yet. Use Postgres, MySQL, or SQLite sources.`,
        );
      }
      const creds = await this.crypto.decryptJson<ConnectionCredentials>(conn.credentialsCt, PURPOSE(conn.id));
      if (creds.ssh) {
        throw new BadRequestException(
          `Source "${s.alias}" uses an SSH tunnel. Federated queries need a direct network path to each source.`,
        );
      }
      resolved.push({ alias: s.alias, connectionId: conn.id, dialect: conn.dialect, creds });
    }
    return resolved;
  }

  async runQuery(
    userId: string,
    sources: FederatedSource[],
    sql: string,
    maxRows = 1000,
  ): Promise<FederatedQueryResult> {
    if (!sql?.trim()) throw new BadRequestException('SQL required');
    const resolved = await this.resolveSources(userId, sources);

    // Cap only applies to top-level SELECT. Wrapping in a subquery with LIMIT
    // N+1 so we can detect truncation — same approach as the main query endpoint.
    const cap = Math.max(0, Math.min(maxRows, 100_000));
    const wrapped =
      cap > 0 && /^\s*select\b/i.test(sql.trim())
        ? `SELECT * FROM (${sql.replace(/;+\s*$/, '')}) AS _dbdash_fq LIMIT ${cap + 1}`
        : sql;

    const started = Date.now();
    const instance = await DuckDBInstance.create(':memory:');
    try {
      const connection = await instance.connect();
      try {
        // Load each extension once; DuckDB allows INSTALL + LOAD on first use
        // and reuses the cache in subsequent calls within this instance.
        const neededExtensions = new Set<string>();
        for (const r of resolved) {
          neededExtensions.add(extensionFor(r.dialect));
        }
        for (const ext of neededExtensions) {
          await connection.run(`INSTALL ${ext}`);
          await connection.run(`LOAD ${ext}`);
        }

        // ATTACH each source under its alias.
        for (const r of resolved) {
          const attachSql = buildAttachSql(r.alias, r.dialect, r.creds);
          await connection.run(attachSql);
        }

        const result = await connection.runAndReadAll(wrapped);
        const fields = result.columnNames().map((name, i) => ({
          name,
          dataType: String(result.columnTypes()[i]),
        }));
        const rows = result.getRowObjects() as Record<string, unknown>[];

        // SECURITY: federated queries build their own engine rather than going
        // through buildDriverForRole, so they never inherited its masking —
        // joining two connections was a way to read columns masked on either.
        // Apply the requesting user's masks from every source involved.
        for (const s of resolved) {
          const masked = await this.masks.maskedColumnNames(userId, s.connectionId);
          if (masked.size > 0) this.masks.applyMasks(rows, masked);
        }

        let truncated = false;
        let finalRows = rows;
        if (cap > 0 && rows.length > cap) {
          finalRows = rows.slice(0, cap);
          truncated = true;
        }

        return {
          rows: finalRows,
          fields,
          rowCount: finalRows.length,
          durationMs: Date.now() - started,
          truncated,
          appliedLimit: cap > 0 ? cap : null,
          sources: resolved.map((r) => ({
            alias: r.alias,
            connectionId: r.connectionId,
            dialect: r.dialect,
          })),
        };
      } finally {
        connection.disconnectSync();
      }
    } catch (err) {
      const message = (err as Error).message;
      this.log.warn(`federated query failed: ${message}`);
      // Surface DuckDB errors as 400s — they're almost always user-query errors,
      // not server errors.
      throw new BadRequestException(message.slice(0, 500));
    } finally {
      instance.closeSync();
    }
  }

  /**
   * Distributed query planner view. Runs DuckDB EXPLAIN and parses what the
   * optimizer pushed down to each remote source vs. what it executes locally.
   *
   * DuckDB's postgres/mysql/sqlite scanners already push filters and
   * projections into the remote scan — this surfaces that so the user can SEE
   * whether their join pulls a full table over the wire (slow) or a filtered
   * slice (fast), and gives actionable warnings.
   */
  async explainPlan(
    userId: string,
    sources: FederatedSource[],
    sql: string,
  ): Promise<FederatedPlan> {
    if (!sql?.trim()) throw new BadRequestException('SQL required');
    const resolved = await this.resolveSources(userId, sources);

    const instance = await DuckDBInstance.create(':memory:');
    try {
      const connection = await instance.connect();
      try {
        const neededExtensions = new Set<string>();
        for (const r of resolved) neededExtensions.add(extensionFor(r.dialect));
        for (const ext of neededExtensions) {
          await connection.run(`INSTALL ${ext}`);
          await connection.run(`LOAD ${ext}`);
        }
        for (const r of resolved) {
          await connection.run(buildAttachSql(r.alias, r.dialect, r.creds));
        }

        const explain = await connection.runAndReadAll(`EXPLAIN ${sql.replace(/;+\s*$/, '')}`);
        // EXPLAIN returns rows of (explain_key, explain_value); join the value
        // column into the full plan text.
        const rows = explain.getRowObjects() as Record<string, unknown>[];
        const raw = rows
          .map((r) => String(r.explain_value ?? Object.values(r).pop() ?? ''))
          .join('\n');

        return this.parsePlan(raw, resolved);
      } finally {
        connection.disconnectSync();
      }
    } catch (err) {
      const message = (err as Error).message;
      this.log.warn(`federated explain failed: ${message}`);
      throw new BadRequestException(message.slice(0, 500));
    } finally {
      instance.closeSync();
    }
  }

  /**
   * Parse a DuckDB physical plan for remote-scan nodes. DuckDB renders scanner
   * nodes as `POSTGRES_SCAN` / `MYSQL_SCAN` / `SQLITE_SCAN` boxes that list the
   * table, the projected columns, and any `Filters:` pushed into the scan.
   * We attribute each scan to a source by the table/alias it references.
   */
  private parsePlan(
    raw: string,
    resolved: Array<{ alias: string; dialect: Dialect }>,
  ): FederatedPlan {
    const sources: SourcePushdown[] = resolved.map((r) => ({
      alias: r.alias,
      dialect: r.dialect,
      tables: [],
      pushedFilters: [],
      projectedColumns: [],
      fullScan: false,
      estimatedRows: null,
    }));
    const byAlias = new Map(sources.map((s) => [s.alias, s]));
    const localOperations: string[] = [];
    const warnings: string[] = [];

    // Split the ASCII-art plan into node blocks. DuckDB separates boxes with
    // lines of pipes/dashes; we tokenize on the node-type headers instead.
    const lines = raw.split('\n');
    const SCAN_RE = /(POSTGRES_SCAN|MYSQL_SCAN|SQLITE_SCAN|POSTGRES_SCAN_PUSHDOWN)/i;
    const LOCAL_RE = /(HASH_JOIN|NESTED_LOOP_JOIN|HASH_GROUP_BY|ORDER_BY|AGGREGATE|PIPELINE)/i;

    let current: SourcePushdown | null = null;
    for (const line of lines) {
      const clean = line.replace(/[│|├─└┌┐┘╞═╡─-╿]/g, ' ').trim();
      if (!clean) continue;

      if (SCAN_RE.test(clean)) {
        // Attribute to whichever alias appears later in this block; default to
        // first source if we can't tell.
        current = null;
        continue;
      }
      if (LOCAL_RE.test(clean)) {
        const op = clean.match(LOCAL_RE)![1];
        if (!localOperations.includes(op)) localOperations.push(op);
        current = null;
        continue;
      }
      // A table reference like `alias.schema.table` or `alias.table`.
      const tableRef = clean.match(/\b([A-Za-z_][\w]*)\.[\w.]+/);
      if (tableRef && byAlias.has(tableRef[1])) {
        current = byAlias.get(tableRef[1])!;
        if (!current.tables.includes(clean)) current.tables.push(clean.slice(0, 120));
        continue;
      }
      if (current) {
        const filt = clean.match(/^Filters?:\s*(.+)$/i);
        if (filt) current.pushedFilters.push(filt[1].slice(0, 200));
        const proj = clean.match(/^Projections?:\s*(.+)$/i);
        if (proj) current.projectedColumns.push(...proj[1].split(',').map((c) => c.trim()).filter(Boolean));
        const card = clean.match(/(?:EC|Estimated Cardinality|cardinality)[:=]\s*([\d,]+)/i);
        if (card) current.estimatedRows = parseInt(card[1].replace(/,/g, ''), 10);
      }
    }

    for (const s of sources) {
      s.fullScan = s.tables.length > 0 && s.pushedFilters.length === 0;
      if (s.fullScan) {
        warnings.push(
          `Source "${s.alias}" is scanned with no pushed-down filter — the whole table is pulled across the network. Add a WHERE on ${s.alias}.* columns to filter at the source.`,
        );
      }
      if (s.estimatedRows && s.estimatedRows > 1_000_000) {
        warnings.push(
          `Source "${s.alias}" is estimated to return ~${s.estimatedRows.toLocaleString()} rows — consider filtering or aggregating before the join.`,
        );
      }
    }

    return { raw, sources, localOperations, warnings };
  }
}

function extensionFor(dialect: Dialect): string {
  switch (dialect) {
    case Dialect.POSTGRES:
      return 'postgres';
    case Dialect.MYSQL:
      return 'mysql';
    case Dialect.SQLITE:
      return 'sqlite';
    default:
      throw new Error(`Unsupported dialect: ${dialect}`);
  }
}

/**
 * Build the `ATTACH` statement for a given dialect + credentials. We embed
 * the connection string as a DuckDB-quoted string — single quotes doubled for
 * escape. Host/port/user/password come from our encrypted creds blob.
 */
function buildAttachSql(alias: string, dialect: Dialect, creds: ConnectionCredentials): string {
  const quotedAlias = `"${alias}"`;
  const q = (s: string) => `'${String(s).replace(/'/g, "''")}'`;

  if (dialect === Dialect.SQLITE) {
    const path = creds.filename ?? ':memory:';
    return `ATTACH ${q(path)} AS ${quotedAlias} (TYPE SQLITE, READ_ONLY)`;
  }

  if (dialect === Dialect.POSTGRES) {
    // libpq-style conninfo; DuckDB's postgres extension accepts it directly.
    const parts: string[] = [];
    if (creds.host) parts.push(`host=${creds.host}`);
    if (creds.port) parts.push(`port=${creds.port}`);
    if (creds.user) parts.push(`user=${creds.user}`);
    if (creds.password) parts.push(`password=${creds.password}`);
    if (creds.database) parts.push(`dbname=${creds.database}`);
    if (creds.sslMode && creds.sslMode !== 'disable') parts.push('sslmode=require');
    const conninfo = parts.join(' ');
    return `ATTACH ${q(conninfo)} AS ${quotedAlias} (TYPE POSTGRES, READ_ONLY)`;
  }

  if (dialect === Dialect.MYSQL) {
    // DuckDB MySQL attach wants a space-separated key=value string.
    const parts: string[] = [];
    if (creds.host) parts.push(`host=${creds.host}`);
    if (creds.port) parts.push(`port=${creds.port}`);
    if (creds.user) parts.push(`user=${creds.user}`);
    if (creds.password) parts.push(`password=${creds.password}`);
    if (creds.database) parts.push(`database=${creds.database}`);
    const conninfo = parts.join(' ');
    return `ATTACH ${q(conninfo)} AS ${quotedAlias} (TYPE MYSQL, READ_ONLY)`;
  }

  throw new ForbiddenException(`Unsupported dialect for federated query: ${dialect}`);
}
