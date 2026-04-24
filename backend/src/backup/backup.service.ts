import {
  BadRequestException,
  Injectable,
  Logger,
  NotImplementedException,
} from '@nestjs/common';
import { spawn } from 'child_process';
import { Response } from 'express';
import { Dialect, Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../crypto/crypto.service';
import { ConnectionsService } from '../connections/connections.service';
import { SshTunnelService } from '../drivers/ssh-tunnel.service';
import { ConnectionCredentials } from '../drivers/driver.interface';

const PURPOSE = (id: string) => `conn:${id}`;

/**
 * Installed pg_dump majors, read from the env var set by the Dockerfile.
 * Matches the postgresql-client-* packages actually installed. If the env
 * isn't set (e.g. local dev outside Docker) we fall back to the system's
 * default `pg_dump` on PATH.
 */
function installedPgDumpMajors(): number[] {
  const raw = process.env.DBSTUDIO_PG_DUMP_MAJORS ?? '';
  return raw
    .split(/[\s,]+/)
    .map((s) => parseInt(s, 10))
    .filter((n) => Number.isFinite(n) && n >= 10)
    .sort((a, b) => b - a); // descending, so "latest" is index 0
}

/**
 * Pick the pg_dump binary whose major matches the remote server. If no exact
 * match is available, prefer the highest installed major that's >= server
 * (backwards-compatible direction). Older-than-server is refused — pg_dump
 * hard-errors on that.
 */
function pickPgDumpBinary(serverMajor: number | null): { cmd: string; note?: string } {
  const majors = installedPgDumpMajors();
  if (majors.length === 0 || serverMajor === null) {
    return { cmd: 'pg_dump' }; // system default
  }
  if (majors.includes(serverMajor)) {
    return { cmd: `/usr/lib/postgresql/${serverMajor}/bin/pg_dump` };
  }
  const higher = majors.filter((m) => m >= serverMajor).sort((a, b) => a - b)[0];
  if (higher) {
    return {
      cmd: `/usr/lib/postgresql/${higher}/bin/pg_dump`,
      note: `Using pg_dump ${higher} against server ${serverMajor} (exact match not installed).`,
    };
  }
  // All installed clients are older than the server. pg_dump will fail; surface
  // it at startup with a clear error rather than a cryptic libpq message.
  throw new BadRequestException(
    `Remote PostgreSQL is major version ${serverMajor}; installed pg_dump clients only go up to ${majors[0]}. Upgrade the API image.`,
  );
}

export type BackupFormat = 'sql' | 'custom';

export interface BackupOptions {
  format: BackupFormat;
  schemaOnly?: boolean;
  /** Restrict to one schema; omit for entire DB. */
  schema?: string;
}

// Identifier guard — pg_dump's -n flag takes a pattern, but we lock it down
// to simple idents (possibly with an optional schema) to avoid injection into
// shell-quoted patterns.
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

@Injectable()
export class BackupService {
  private readonly log = new Logger(BackupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly ssh: SshTunnelService,
    private readonly connections: ConnectionsService,
  ) {}

  /**
   * Pre-flight size estimate so the UI can render a rough percentage. Returns
   * on-disk bytes per `pg_total_relation_size` summed across base tables.
   * Compressed plain-SQL output is typically ~0.5–2× this number — wildly
   * imprecise but better than no signal. Only applicable to Postgres.
   */
  /**
   * Cheap probe for the remote server's major version so we can pick a
   * matching pg_dump binary. `SHOW server_version_num` returns an integer
   * like 170001 for PG 17.1, from which we extract the major (170001 / 10000 = 17).
   */
  private async detectPostgresMajor(connectionId: string): Promise<number | null> {
    const drv = await this.connections.buildDriverForRole(connectionId, Role.VIEWER);
    try {
      const r = await drv.runRawQuery(`SHOW server_version_num`);
      const row = r.rows[0] as Record<string, unknown> | undefined;
      const value = row ? Object.values(row)[0] : undefined;
      const n = typeof value === 'string' ? parseInt(value, 10) : typeof value === 'number' ? value : NaN;
      if (!Number.isFinite(n)) return null;
      return Math.floor(n / 10_000);
    } catch (err) {
      this.log.warn(`server_version_num probe failed: ${(err as Error).message}`);
      return null;
    } finally {
      await drv.close().catch(() => {});
    }
  }

  async estimateSize(
    connectionId: string,
    opts: { schema?: string } = {},
  ): Promise<{ bytes: number | null; tables: number; note: string }> {
    const drv = await this.connections.buildDriverForRole(connectionId, Role.VIEWER);
    try {
      if (drv.dialect !== Dialect.POSTGRES) {
        return { bytes: null, tables: 0, note: 'Estimate only available for PostgreSQL' };
      }
      const where = opts.schema
        ? `AND n.nspname = '${opts.schema.replace(/'/g, "''")}'`
        : "AND n.nspname NOT IN ('pg_catalog','information_schema')";
      const sql = `
        SELECT COALESCE(SUM(pg_total_relation_size(c.oid)), 0)::text AS bytes,
               COUNT(*)::int AS tables
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relkind = 'r' ${where}
      `;
      const r = await drv.runRawQuery(sql);
      const row = r.rows[0] as { bytes?: string; tables?: number } | undefined;
      const bytes = row?.bytes ? Number(row.bytes) : 0;
      return {
        bytes: Number.isFinite(bytes) ? bytes : null,
        tables: row?.tables ?? 0,
        note: 'On-disk size; dump output typically 50–200% of this',
      };
    } finally {
      await drv.close().catch(() => {});
    }
  }

  async streamBackup(connectionId: string, opts: BackupOptions, res: Response): Promise<void> {
    const conn = await this.prisma.connection.findUnique({
      where: { id: connectionId },
      select: { id: true, name: true, dialect: true, credentialsCt: true },
    });
    if (!conn) throw new BadRequestException('Connection not found');

    if (conn.dialect !== Dialect.POSTGRES) {
      throw new NotImplementedException(
        `Backup is only supported for PostgreSQL connections right now (got ${conn.dialect}). ` +
          `mysqldump / sqlcmd wrappers can be added in a later release.`,
      );
    }
    if (opts.schema && !IDENT_RE.test(opts.schema)) {
      throw new BadRequestException('Invalid schema name');
    }

    const rawCreds = await this.crypto.decryptJson<ConnectionCredentials>(conn.credentialsCt, PURPOSE(connectionId));
    if (!rawCreds.host || !rawCreds.port) {
      throw new BadRequestException('Connection is missing host/port');
    }

    // Detect the remote Postgres major version so we can pick the matching
    // pg_dump binary from the installed set. This is a cheap SELECT — a few ms
    // on top of the backup — and catches the most common source of backup
    // failures: "server version newer than pg_dump" from a mismatched client.
    const serverMajor = await this.detectPostgresMajor(connectionId);
    const binary = pickPgDumpBinary(serverMajor);
    if (binary.note) this.log.log(binary.note);

    // Open SSH tunnel if configured — pg_dump will point at the local forwarded
    // endpoint. Tunnel must live until pg_dump exits.
    const { host, port, tunnel } =
      rawCreds.ssh
        ? await (async () => {
            const t = await this.ssh.open(rawCreds.ssh!, rawCreds.host!, rawCreds.port!);
            return { host: t.localHost, port: t.localPort, tunnel: t };
          })()
        : { host: rawCreds.host, port: rawCreds.port, tunnel: null as null | Awaited<ReturnType<SshTunnelService['open']>> };

    const args: string[] = [
      '--host', host,
      '--port', String(port),
      '--username', rawCreds.user ?? 'postgres',
      '--dbname', rawCreds.database ?? 'postgres',
      '--no-password', // rely on PGPASSWORD env; fail fast if missing
      '--verbose',
    ];
    if (opts.schemaOnly) args.push('--schema-only');
    if (opts.schema) args.push('--schema', opts.schema);
    if (opts.format === 'custom') args.push('--format=custom');
    else args.push('--format=plain');

    // Pass password via env — never in argv (ps would show it).
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PGPASSWORD: rawCreds.password ?? '',
      // Timeout guard: if remote is unreachable, fail within 30s instead of hanging.
      PGCONNECT_TIMEOUT: '30',
    };

    const ext = opts.format === 'custom' ? 'dump' : 'sql';
    const safeName = conn.name.replace(/[^a-z0-9-_]+/gi, '_');
    const filename = `${safeName}-${new Date().toISOString().slice(0, 10)}.${ext}`;

    // Pre-flight estimate so the client shows a rough percentage right away.
    // Skipped for --schema-only because on-disk size includes data, which
    // overestimates a schema-only dump wildly.
    let estimate: { bytes: number | null; tables: number } = { bytes: null, tables: 0 };
    if (!opts.schemaOnly) {
      try {
        estimate = await this.estimateSize(connectionId, { schema: opts.schema });
      } catch (err) {
        this.log.warn(`estimate failed, continuing without: ${(err as Error).message}`);
      }
    }

    res.setHeader('Content-Type',
      opts.format === 'custom' ? 'application/octet-stream' : 'application/sql');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Custom headers expose progress hints to the client — it subtracts bytes
    // received from estimate to draw a progress bar.
    if (estimate.bytes !== null) {
      res.setHeader('X-Dbdash-Estimate-Bytes', String(estimate.bytes));
    }
    if (estimate.tables > 0) {
      res.setHeader('X-Dbdash-Tables-Total', String(estimate.tables));
    }
    // Must be listed in Access-Control-Expose-Headers for the browser to read
    // them via fetch() / axios on a cross-origin response.
    res.setHeader(
      'Access-Control-Expose-Headers',
      'Content-Disposition, X-Dbdash-Estimate-Bytes, X-Dbdash-Tables-Total',
    );

    this.log.log(`pg_dump start conn=${connectionId} fmt=${opts.format} schemaOnly=${!!opts.schemaOnly}`);
    const child = spawn(binary.cmd, args, { env });

    // Collect a tail of stderr so we can surface something useful on failure.
    const stderrBuf: Buffer[] = [];
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrBuf.length < 64) stderrBuf.push(chunk);
    });

    // Pipe dump output directly to the response.
    child.stdout.pipe(res);

    const cleanup = async () => {
      if (tunnel) await tunnel.close().catch(() => {});
    };

    child.on('error', async (err) => {
      this.log.error(`pg_dump spawn error: ${err.message}`);
      await cleanup();
      if (!res.headersSent) {
        res.status(500).json({ message: 'Failed to start pg_dump (is it installed?)' });
      } else {
        // Best-effort — already streaming, close the socket so the client knows.
        res.destroy(err);
      }
    });

    child.on('close', async (code) => {
      await cleanup();
      if (code !== 0) {
        const tail = Buffer.concat(stderrBuf).toString('utf8').slice(-2000);
        this.log.warn(`pg_dump exited ${code}: ${tail}`);
        // If we haven't flushed headers yet we can still return JSON.
        if (!res.headersSent) {
          res.status(500).json({ message: `pg_dump failed: ${tail.split('\n').pop() || 'exit code ' + code}` });
          return;
        }
        // Otherwise end the response — the partial file will still reach the client.
        res.end();
      } else {
        this.log.log(`pg_dump ok conn=${connectionId}`);
        res.end();
      }
    });

    // If the client disconnects (cancelled download), kill pg_dump.
    res.on('close', () => {
      if (!child.killed) child.kill('SIGTERM');
    });
  }
}
