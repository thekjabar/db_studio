import { BadRequestException, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { Client as PgClient } from 'pg';
import { Dialect, Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../crypto/crypto.service';
import { ColumnMasksService } from '../connections/column-masks.service';
import { ConnectionCredentials } from '../drivers/driver.interface';

/**
 * Server-side cursor streaming for large result sets (Postgres).
 *
 * The row-cap approach (LIMIT cap+1) is fine for "show me the first 1000 rows",
 * but it can't paginate a 10M-row analytical result without either re-running
 * the whole query per page (OFFSET — O(n²) total work) or buffering everything
 * in memory. A server-side cursor solves both: the query plan is established
 * once, and each page is a cheap `FETCH FORWARD n` against the held portal.
 *
 * The hazard is resource leakage: a cursor holds a transaction open on a
 * dedicated connection. If a client opens one and walks away, that connection
 * is pinned forever. This service defends against that aggressively:
 *   - dedicated pg.Client per cursor (NOT from a request-scoped pool, which is
 *     torn down after the response),
 *   - hard idle timeout (closed after IDLE_MS with no fetch),
 *   - hard max lifetime (closed after MAX_LIFETIME_MS regardless of activity),
 *   - a global cap on concurrent open cursors (refuses new ones past the cap),
 *   - a reaper sweeping on an interval,
 *   - close-all on module destroy.
 *
 * Postgres only. Other dialects throw `unsupported` so the UI falls back to
 * offset pagination. SSH-tunnelled connections are also unsupported here (the
 * dedicated client doesn't set up the tunnel) — same fallback.
 */

interface CursorSession {
  id: string;
  connectionId: string;
  userId: string;
  client: PgClient;
  fields: { name: string; dataType?: string }[] | null;
  createdAt: number;
  lastUsedAt: number;
  exhausted: boolean;
  /**
   * SECURITY: this service opens its own PgClient rather than going through
   * buildDriverForRole, so it never inherited the driver-level masking. The
   * user's masked columns are resolved once at open and applied to every page.
   */
  masked: Set<string>;
  /** Serializes fetches so two concurrent FETCHes can't interleave on one client. */
  chain: Promise<unknown>;
}

const IDLE_MS = 2 * 60 * 1000;        // close after 2 min with no fetch
const MAX_LIFETIME_MS = 10 * 60 * 1000; // hard cap regardless of activity
const MAX_OPEN_CURSORS = 50;          // global ceiling
const MAX_PAGE = 5_000;               // rows per FETCH
const SWEEP_MS = 30 * 1000;

@Injectable()
export class CursorService implements OnModuleDestroy {
  private readonly log = new Logger(CursorService.name);
  private readonly sessions = new Map<string, CursorSession>();
  private readonly sweeper: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly masks: ColumnMasksService,
  ) {
    this.sweeper = setInterval(() => void this.sweep(), SWEEP_MS);
    // Don't keep the process alive just for the sweeper.
    this.sweeper.unref?.();
  }

  async onModuleDestroy() {
    clearInterval(this.sweeper);
    await Promise.all([...this.sessions.values()].map((s) => this.closeSession(s.id).catch(() => {})));
  }

  /**
   * Open a cursor for a SELECT. Returns the cursor id, the column metadata, and
   * the first page. The query is validated as a single SELECT by the caller
   * (this service additionally rejects anything with a semicolon-separated
   * second statement).
   */
  async open(params: {
    connectionId: string;
    userId: string;
    role: Role;
    sql: string;
    pageSize: number;
  }): Promise<{
    cursorId: string;
    fields: { name: string; dataType?: string }[];
    rows: Record<string, unknown>[];
    done: boolean;
  }> {
    const { connectionId, userId, sql } = params;
    const pageSize = Math.min(Math.max(params.pageSize || 1000, 1), MAX_PAGE);

    const conn = await this.prisma.connection.findUnique({ where: { id: connectionId } });
    if (!conn) throw new BadRequestException('Connection not found');
    if (conn.dialect !== Dialect.POSTGRES) {
      throw new BadRequestException({ code: 'CURSOR_UNSUPPORTED', message: 'Cursor streaming is only available for PostgreSQL' });
    }
    // Reject multi-statement up front — a cursor wraps exactly one query.
    const trimmed = sql.trim().replace(/;\s*$/, '');
    if (trimmed.includes(';')) {
      throw new BadRequestException('Cursor queries must be a single statement');
    }
    if (!/^\s*(select|with)\b/i.test(trimmed)) {
      throw new BadRequestException('Cursor streaming supports SELECT queries only');
    }

    if (this.sessions.size >= MAX_OPEN_CURSORS) {
      // Try a sweep first — there may be reapable sessions.
      await this.sweep();
      if (this.sessions.size >= MAX_OPEN_CURSORS) {
        throw new BadRequestException({
          code: 'CURSOR_LIMIT',
          message: 'Too many open cursors on this server. Close one or retry shortly.',
        });
      }
    }

    const creds = await this.crypto.decryptJson<ConnectionCredentials>(
      conn.credentialsCt,
      `conn:${connectionId}`,
    );
    if (creds.ssh) {
      throw new BadRequestException({
        code: 'CURSOR_UNSUPPORTED',
        message: 'Cursor streaming is not available over SSH tunnels',
      });
    }

    const client = new PgClient({
      host: creds.host,
      port: creds.port ?? 5432,
      user: creds.user,
      password: creds.password,
      database: creds.database,
      ssl:
        creds.sslMode && creds.sslMode !== 'disable'
          ? { rejectUnauthorized: creds.sslMode === 'verify-full' }
          : undefined,
      // Cap how long any single statement (including a runaway FETCH) can run.
      statement_timeout: conn.statementTimeoutMs ?? 30_000,
    });

    const cursorId = randomBytes(18).toString('hex');
    const pgCursorName = `dbdash_cur_${cursorId.slice(0, 16)}`;

    try {
      await client.connect();
      // Read-only transaction holding the cursor. READ ONLY both enforces
      // safety and lets Postgres avoid taking write locks.
      await client.query('BEGIN READ ONLY');
      await client.query(`DECLARE ${pgCursorName} NO SCROLL CURSOR FOR ${trimmed}`);
    } catch (err) {
      await client.end().catch(() => {});
      throw new BadRequestException((err as Error).message);
    }

    const session: CursorSession = {
      id: cursorId,
      connectionId,
      userId,
      client,
      fields: null,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      exhausted: false,
      masked: await this.masks.maskedColumnNames(userId, connectionId),
      chain: Promise.resolve(),
    };
    // Store the pg cursor name on the session via closure in fetch — keep it
    // simple by recomputing from id (deterministic).
    this.sessions.set(cursorId, session);

    const first = await this.fetch(cursorId, userId, pageSize);
    return { cursorId, fields: first.fields, rows: first.rows, done: first.done };
  }

  /** Fetch the next page. Enforces ownership and serializes per-session. */
  async fetch(
    cursorId: string,
    userId: string,
    pageSize: number,
  ): Promise<{ fields: { name: string; dataType?: string }[]; rows: Record<string, unknown>[]; done: boolean }> {
    const session = this.sessions.get(cursorId);
    if (!session) throw new BadRequestException({ code: 'CURSOR_GONE', message: 'Cursor not found or expired' });
    if (session.userId !== userId) throw new BadRequestException('Cursor belongs to another user');

    const n = Math.min(Math.max(pageSize || 1000, 1), MAX_PAGE);
    const pgCursorName = `dbdash_cur_${cursorId.slice(0, 16)}`;

    // Serialize on the session's chain so concurrent fetches don't corrupt the
    // single underlying connection's protocol state.
    const run = session.chain.then(async () => {
      if (session.exhausted) {
        return { fields: session.fields ?? [], rows: [] as Record<string, unknown>[], done: true };
      }
      const res = await session.client.query({
        text: `FETCH FORWARD ${n} FROM ${pgCursorName}`,
        rowMode: 'array' as never,
      }).catch((err) => {
        throw new BadRequestException((err as Error).message);
      });

      // First fetch establishes field metadata.
      const fields = (res as { fields: { name: string; dataTypeID: number }[] }).fields.map((f) => ({
        name: f.name,
      }));
      if (!session.fields) session.fields = fields;

      // rowMode: array gives positional arrays — map back to objects by field.
      const arrayRows = (res as { rows: unknown[][] }).rows;
      const rows = arrayRows.map((arr) => {
        const obj: Record<string, unknown> = {};
        session.fields!.forEach((f, i) => (obj[f.name] = arr[i]));
        return obj;
      });
      // SECURITY: apply this user's column masks. The same SQL via POST /query
      // is masked; without this, switching to the cursor endpoint returned the
      // masked columns in the clear.
      if (session.masked.size > 0) this.masks.applyMasks(rows, session.masked);

      session.lastUsedAt = Date.now();
      const done = rows.length < n;
      if (done) {
        session.exhausted = true;
        // Eagerly free the connection once the result is fully drained.
        void this.closeSession(cursorId).catch(() => {});
      }
      return { fields: session.fields, rows, done };
    });

    // Keep the chain alive even if this fetch rejects.
    session.chain = run.catch(() => {});
    return run;
  }

  /** Explicitly close a cursor (client clicked away / finished early). */
  async close(cursorId: string, userId: string): Promise<{ closed: boolean }> {
    const session = this.sessions.get(cursorId);
    if (!session) return { closed: false };
    if (session.userId !== userId) throw new BadRequestException('Cursor belongs to another user');
    await this.closeSession(cursorId);
    return { closed: true };
  }

  private async closeSession(cursorId: string) {
    const session = this.sessions.get(cursorId);
    if (!session) return;
    this.sessions.delete(cursorId);
    try {
      // ROLLBACK ends the read-only transaction and drops the cursor.
      await session.client.query('ROLLBACK').catch(() => {});
    } finally {
      await session.client.end().catch(() => {});
    }
  }

  /** Reap idle and over-aged sessions. */
  private async sweep() {
    const now = Date.now();
    const doomed: string[] = [];
    for (const s of this.sessions.values()) {
      if (now - s.lastUsedAt > IDLE_MS || now - s.createdAt > MAX_LIFETIME_MS) {
        doomed.push(s.id);
      }
    }
    for (const id of doomed) {
      this.log.debug(`reaping cursor ${id}`);
      await this.closeSession(id).catch(() => {});
    }
  }

  /** Diagnostics — count of currently held cursors. */
  get openCount() {
    return this.sessions.size;
  }
}
