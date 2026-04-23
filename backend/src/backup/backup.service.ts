import {
  BadRequestException,
  Injectable,
  Logger,
  NotImplementedException,
} from '@nestjs/common';
import { spawn } from 'child_process';
import { Response } from 'express';
import { Dialect } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../crypto/crypto.service';
import { SshTunnelService } from '../drivers/ssh-tunnel.service';
import { ConnectionCredentials } from '../drivers/driver.interface';

const PURPOSE = (id: string) => `conn:${id}`;

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
  ) {}

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

    const rawCreds = this.crypto.decryptJson<ConnectionCredentials>(conn.credentialsCt, PURPOSE(connectionId));
    if (!rawCreds.host || !rawCreds.port) {
      throw new BadRequestException('Connection is missing host/port');
    }

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

    res.setHeader('Content-Type',
      opts.format === 'custom' ? 'application/octet-stream' : 'application/sql');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');

    this.log.log(`pg_dump start conn=${connectionId} fmt=${opts.format} schemaOnly=${!!opts.schemaOnly}`);
    const child = spawn('pg_dump', args, { env });

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
