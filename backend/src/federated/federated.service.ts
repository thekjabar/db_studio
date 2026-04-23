import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { DuckDBInstance } from '@duckdb/node-api';
import { Dialect, Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../crypto/crypto.service';
import { RbacService } from '../rbac/rbac.service';
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
  ) {}

  async runQuery(
    userId: string,
    sources: FederatedSource[],
    sql: string,
    maxRows = 1000,
  ): Promise<FederatedQueryResult> {
    if (!sql?.trim()) throw new BadRequestException('SQL required');
    if (!Array.isArray(sources) || sources.length === 0) {
      throw new BadRequestException('At least one source is required');
    }
    if (sources.length > 5) {
      throw new BadRequestException('Maximum 5 sources per federated query');
    }

    const usedAliases = new Set<string>();
    const resolved: Array<{ alias: string; connectionId: string; dialect: Dialect; creds: ConnectionCredentials }> = [];
    for (const s of sources) {
      if (!IDENT_RE.test(s.alias)) {
        throw new BadRequestException(`Invalid alias: ${s.alias}`);
      }
      if (usedAliases.has(s.alias)) {
        throw new BadRequestException(`Duplicate alias: ${s.alias}`);
      }
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
      const creds = this.crypto.decryptJson<ConnectionCredentials>(conn.credentialsCt, PURPOSE(conn.id));
      if (creds.ssh) {
        throw new BadRequestException(
          `Source "${s.alias}" uses an SSH tunnel. Federated queries need a direct network path to each source.`,
        );
      }
      resolved.push({ alias: s.alias, connectionId: conn.id, dialect: conn.dialect, creds });
    }

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
