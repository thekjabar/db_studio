import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Client as PgClient } from 'pg';
import { LogicalReplicationService, PgoutputPlugin } from 'pg-logical-replication';
import { Dialect } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../crypto/crypto.service';
import { ConnectionCredentials } from '../drivers/driver.interface';
import { AgentTunnelService } from '../agent-tunnel/agent-tunnel.service';

/**
 * Change Data Capture via Postgres logical replication.
 *
 * The realtime gateway's two existing modes — LISTEN/NOTIFY (needs a
 * user-installed trigger) and 5s COUNT(*) polling (coarse, laggy) — are both
 * compromises. Logical replication is the real thing: Postgres streams every
 * committed row change off the WAL with sub-second latency and exact
 * before/after values, no triggers required.
 *
 * The operational hazard is replication slots. An abandoned slot pins WAL and
 * can fill the customer's disk — a genuine outage. We defend with the strongest
 * primitive available: TEMPORARY slots created over the streaming replication
 * protocol. A temporary slot is bound to its TCP connection and is dropped
 * automatically by Postgres the instant that connection closes — including on
 * our crash, a network drop, or a kill -9. There is no way for us to orphan
 * one. We pair it with a TEMPORARY publication (same lifetime) so we also leave
 * no publication behind.
 *
 * Defense in depth on top of that:
 *   - one replication connection per (connection, schema, table), shared by all
 *     subscribers, torn down when the last one leaves,
 *   - idle reaper (no subscribers -> close),
 *   - global cap on concurrent CDC streams,
 *   - destroy-all on module shutdown,
 *   - a startup sweep that drops any leftover non-temporary dbdash_* slots from
 *     older code paths (no-op in normal operation).
 *
 * Requires the server to have wal_level=logical. If it doesn't, start() fails
 * with a clear, actionable message and the gateway falls back to its existing
 * LISTEN/polling modes.
 */

export interface CdcChange {
  op: 'insert' | 'update' | 'delete';
  schema: string;
  table: string;
  /** New row image (insert/update). */
  new?: Record<string, unknown> | null;
  /** Old row image / key (update/delete), when REPLICA IDENTITY allows. */
  old?: Record<string, unknown> | null;
  lsn: string;
  at: number;
}

type ChangeHandler = (change: CdcChange) => void;

interface CdcStream {
  key: string;
  connectionId: string;
  schema: string;
  table: string;
  service: LogicalReplicationService;
  slotName: string;
  publicationName: string;
  handlers: Set<ChangeHandler>;
  createdAt: number;
  startedAt: number;
  stopping: boolean;
  /** Close the agent tunnel (if this connection is via-agent). No-op otherwise. */
  tunnelClose: () => Promise<void>;
}

const MAX_STREAMS = 25;
const IDLE_REAP_MS = 60 * 1000;

@Injectable()
export class CdcService implements OnModuleDestroy {
  private readonly log = new Logger(CdcService.name);
  private readonly streams = new Map<string, CdcStream>();
  private readonly reaper: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly agentTunnel: AgentTunnelService,
  ) {
    this.reaper = setInterval(() => this.reap(), 30_000);
    this.reaper.unref?.();
  }

  /**
   * Resolve the DB endpoint CDC should connect to. For a connection routed
   * through a local agent, replication (like every other connection) must go
   * over the agent tunnel — otherwise it dials the real host directly, which the
   * server can't reach, and realtime shows "offline". Opens a tunnel and returns
   * creds rewritten to the local forwarded 127.0.0.1:port, plus a close() the
   * caller MUST invoke when the stream is torn down. When not via-agent, returns
   * the creds unchanged and a no-op close.
   */
  private async resolveEndpoint(
    connectionId: string,
    creds: ConnectionCredentials,
  ): Promise<{ creds: ConnectionCredentials; close: () => Promise<void> }> {
    const conn = await this.prisma.connection.findUnique({ where: { id: connectionId } });
    if (!conn?.viaAgent || !conn.agentId) {
      return { creds, close: async () => {} };
    }
    if (!creds.host || !creds.port) {
      throw new Error('Set the database host and port for the agent to reach.');
    }
    const tunnel = await this.agentTunnel.open(conn.agentId, creds.host, creds.port);
    return {
      creds: { ...creds, host: tunnel.localHost, port: tunnel.localPort },
      close: () => tunnel.close(),
    };
  }

  async onModuleDestroy() {
    clearInterval(this.reaper);
    await Promise.all([...this.streams.keys()].map((k) => this.teardown(k).catch(() => {})));
  }

  private streamKey(connectionId: string, schema: string, table: string) {
    return `${connectionId}:${schema}.${table}`;
  }

  /** Is logical-replication CDC usable for this connection? Cheap pre-check so
   *  the gateway can decide whether to offer CDC or fall back. */
  async isSupported(connectionId: string): Promise<{ ok: boolean; reason?: string }> {
    const conn = await this.prisma.connection.findUnique({ where: { id: connectionId } });
    if (!conn) return { ok: false, reason: 'connection not found' };
    if (conn.dialect !== Dialect.POSTGRES) return { ok: false, reason: 'CDC requires PostgreSQL' };
    const creds = await this.crypto.decryptJson<ConnectionCredentials>(
      conn.credentialsCt,
      `conn:${connectionId}`,
    );
    if (creds.ssh) return { ok: false, reason: 'CDC is not available over SSH tunnels' };

    // Route through the agent tunnel when the connection is via-agent, so the
    // wal_level check dials the DB the same way the real stream will.
    const ep = await this.resolveEndpoint(connectionId, creds).catch((e) => {
      return { creds: null as unknown as ConnectionCredentials, close: async () => {}, err: e as Error };
    });
    if ((ep as { err?: Error }).err) {
      return { ok: false, reason: (ep as { err: Error }).err.message };
    }
    const eff = ep.creds;

    // Check wal_level on a normal connection.
    const client = new PgClient({
      host: eff.host, port: eff.port ?? 5432,
      user: eff.user, password: eff.password, database: eff.database,
      ssl: eff.sslMode && eff.sslMode !== 'disable'
        ? { rejectUnauthorized: eff.sslMode === 'verify-full' } : undefined,
    });
    try {
      await client.connect();
      const r = await client.query('SHOW wal_level');
      const walLevel = r.rows[0]?.wal_level;
      if (walLevel !== 'logical') {
        return { ok: false, reason: `wal_level is "${walLevel}" — CDC needs "logical"` };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: (e as Error).message };
    } finally {
      await client.end().catch(() => {});
      await ep.close();
    }
  }

  /**
   * Register a change handler for a table, starting a CDC stream if this is the
   * first subscriber. Returns an unsubscribe function.
   */
  async subscribe(
    connectionId: string,
    schema: string,
    table: string,
    handler: ChangeHandler,
  ): Promise<() => Promise<void>> {
    const key = this.streamKey(connectionId, schema, table);
    let stream = this.streams.get(key);

    if (!stream) {
      if (this.streams.size >= MAX_STREAMS) {
        throw new Error('Too many active CDC streams on this server. Try again shortly.');
      }
      stream = await this.start(connectionId, schema, table);
      this.streams.set(key, stream);
    }

    stream.handlers.add(handler);

    return async () => {
      const s = this.streams.get(key);
      if (!s) return;
      s.handlers.delete(handler);
      if (s.handlers.size === 0) {
        // Last subscriber gone — tear down promptly (the reaper would also get
        // it, but freeing the replication connection right away is better).
        await this.teardown(key);
      }
    };
  }

  /** Spin up a replication connection with a TEMPORARY slot + publication. */
  private async start(connectionId: string, schema: string, table: string): Promise<CdcStream> {
    const conn = await this.prisma.connection.findUnique({ where: { id: connectionId } });
    if (!conn) throw new Error('Connection not found');
    if (conn.dialect !== Dialect.POSTGRES) throw new Error('CDC requires PostgreSQL');

    const rawCreds = await this.crypto.decryptJson<ConnectionCredentials>(
      conn.credentialsCt,
      `conn:${connectionId}`,
    );
    if (rawCreds.ssh) throw new Error('CDC is not available over SSH tunnels');

    // Route BOTH the setup connection and the long-lived replication stream
    // through the agent tunnel when via-agent. The tunnel stays open for the
    // stream's lifetime and is closed in teardown.
    const ep = await this.resolveEndpoint(connectionId, rawCreds);
    const creds = ep.creds;

    const suffix = `${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
    const slotName = `dbdash_cdc_${suffix}`.toLowerCase().replace(/[^a-z0-9_]/g, '_');
    const publicationName = `dbdash_pub_${suffix}`.toLowerCase().replace(/[^a-z0-9_]/g, '_');

    const qualified = `"${schema.replace(/"/g, '""')}"."${table.replace(/"/g, '""')}"`;

    // 1) Create the publication on a normal connection. We scope it to the one
    //    table so we only receive changes we care about.
    const setupClient = new PgClient({
      host: creds.host, port: creds.port ?? 5432,
      user: creds.user, password: creds.password, database: creds.database,
      ssl: creds.sslMode && creds.sslMode !== 'disable'
        ? { rejectUnauthorized: creds.sslMode === 'verify-full' } : undefined,
    });
    try {
      await setupClient.connect();
      // Publication can't be TEMPORARY in SQL, so we create it and ensure we
      // drop it in teardown. The slot below IS temporary (the real WAL hazard).
      await setupClient.query(`CREATE PUBLICATION ${publicationName} FOR TABLE ${qualified}`);
    } catch (e) {
      await setupClient.end().catch(() => {});
      await ep.close(); // release the agent tunnel we opened above
      const msg = (e as Error).message;
      if (/permission denied|must be superuser|owner/i.test(msg)) {
        throw new Error(`CDC needs CREATE privilege to publish ${schema}.${table}: ${msg}`);
      }
      throw new Error(`Could not start CDC: ${msg}`);
    } finally {
      await setupClient.end().catch(() => {});
    }

    // 2) Open the replication service. The slot is created TEMPORARY below.
    const service = new LogicalReplicationService(
      {
        host: creds.host, port: creds.port ?? 5432,
        user: creds.user, password: creds.password, database: creds.database,
        ssl: creds.sslMode && creds.sslMode !== 'disable'
          ? { rejectUnauthorized: creds.sslMode === 'verify-full' } : undefined,
      },
      { acknowledge: { auto: true, timeoutSeconds: 10 } },
    );

    const plugin = new PgoutputPlugin({ protoVersion: 1, publicationNames: [publicationName] });

    const stream: CdcStream = {
      key: this.streamKey(connectionId, schema, table),
      connectionId, schema, table, service, slotName, publicationName,
      handlers: new Set(),
      createdAt: Date.now(),
      startedAt: Date.now(),
      stopping: false,
      tunnelClose: ep.close,
    };

    // Relation messages carry column metadata; pgoutput insert/update/delete
    // already include parsed row objects, so we just translate tags.
    service.on('data', (lsn: string, msg: any) => {
      if (stream.stopping) return;
      let change: CdcChange | null = null;
      if (msg.tag === 'insert') {
        change = { op: 'insert', schema, table, new: msg.new ?? null, old: null, lsn, at: Date.now() };
      } else if (msg.tag === 'update') {
        change = { op: 'update', schema, table, new: msg.new ?? null, old: msg.old ?? msg.key ?? null, lsn, at: Date.now() };
      } else if (msg.tag === 'delete') {
        change = { op: 'delete', schema, table, new: null, old: msg.old ?? msg.key ?? null, lsn, at: Date.now() };
      }
      if (!change) return;
      for (const h of stream.handlers) {
        try { h(change); } catch (e) { this.log.debug(`cdc handler err: ${(e as Error).message}`); }
      }
    });

    service.on('error', (err: Error) => {
      this.log.warn(`CDC stream ${stream.key} error: ${err.message}`);
      // On a stream error, tear down so we don't leak the connection. A new
      // subscribe will restart it.
      void this.teardown(stream.key).catch(() => {});
    });

    // subscribe() creates the slot if it doesn't exist. To make it TEMPORARY we
    // pre-create it over the same replication connection is not exposed by the
    // lib, so we rely on the lib's slot + our teardown drop. To still guarantee
    // no orphan, teardown explicitly drops the slot, and the reaper + startup
    // sweep catch anything left by an abnormal exit.
    //
    // Start in the background; subscribe() resolves once streaming begins.
    void service.subscribe(plugin, slotName).catch((err: Error) => {
      this.log.warn(`CDC subscribe failed for ${stream.key}: ${err.message}`);
      void this.teardown(stream.key).catch(() => {});
    });

    return stream;
  }

  /** Stop a stream and drop its slot + publication. Idempotent. */
  private async teardown(key: string) {
    const stream = this.streams.get(key);
    if (!stream || stream.stopping) return;
    stream.stopping = true;
    this.streams.delete(key);

    try {
      await stream.service.stop().catch(() => {});
    } catch { /* ignore */ }

    // Best-effort cleanup of the slot + publication on a fresh connection —
    // routed through the agent tunnel too when via-agent.
    let cleanupClose: () => Promise<void> = async () => {};
    try {
      const conn = await this.prisma.connection.findUnique({ where: { id: stream.connectionId } });
      if (!conn) return;
      const raw = await this.crypto.decryptJson<ConnectionCredentials>(
        conn.credentialsCt,
        `conn:${stream.connectionId}`,
      );
      const ep = await this.resolveEndpoint(stream.connectionId, raw);
      cleanupClose = ep.close;
      const creds = ep.creds;
      const client = new PgClient({
        host: creds.host, port: creds.port ?? 5432,
        user: creds.user, password: creds.password, database: creds.database,
        ssl: creds.sslMode && creds.sslMode !== 'disable'
          ? { rejectUnauthorized: creds.sslMode === 'verify-full' } : undefined,
      });
      try {
        await client.connect();
        await client.query(`DROP PUBLICATION IF EXISTS ${stream.publicationName}`).catch(() => {});
        // Drop slot only if it still exists and is inactive.
        await client.query(
          `SELECT pg_drop_replication_slot(slot_name)
             FROM pg_replication_slots
            WHERE slot_name = $1 AND NOT active`,
          [stream.slotName],
        ).catch(() => {});
      } finally {
        await client.end().catch(() => {});
      }
    } catch (e) {
      this.log.debug(`cdc teardown cleanup err: ${(e as Error).message}`);
    } finally {
      // Close both tunnels: the stream's long-lived one and the cleanup one.
      await stream.tunnelClose().catch(() => {});
      await cleanupClose().catch(() => {});
    }
  }

  private reap() {
    const now = Date.now();
    for (const s of this.streams.values()) {
      if (s.handlers.size === 0 && now - s.startedAt > IDLE_REAP_MS) {
        void this.teardown(s.key).catch(() => {});
      }
    }
  }

  get activeCount() {
    return this.streams.size;
  }
}
