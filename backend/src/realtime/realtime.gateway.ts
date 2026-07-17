import { Logger, UnauthorizedException } from '@nestjs/common';
import {
  ConnectedSocket, MessageBody, OnGatewayConnection, OnGatewayDisconnect,
  SubscribeMessage, WebSocketGateway, WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { Client as PgClient } from 'pg';
import { Dialect, Role } from '@prisma/client';
import { AppConfigService } from '../config/config.service';
import { ConnectionsService } from '../connections/connections.service';
import { RbacService } from '../rbac/rbac.service';
import { CryptoService } from '../crypto/crypto.service';
import { ColumnMasksService } from '../connections/column-masks.service';
import { PrismaService } from '../prisma/prisma.service';
import { ConnectionCredentials } from '../drivers/driver.interface';
import { CdcService } from './cdc.service';

interface AuthedSocket extends Socket { userId?: string }

interface SubState {
  pgClient?: PgClient;
  pollTimer?: NodeJS.Timeout;
  /** Unsubscribe fn returned by CdcService when this sub uses logical replication. */
  cdcUnsub?: () => Promise<void>;
}

/**
 * WS gateway at /realtime.
 * Client flow:
 *  1) connect with `auth: { token }`
 *  2) emit `subscribe` { connectionId, schema, table, pk }
 *     -> server subscribes via Postgres LISTEN/NOTIFY on channel `table_change_<schema>_<table>`
 *        (user must install a matching trigger on their DB — docs in README),
 *        OR polls the table for rowcount/max(pk) every 5s as a fallback for other dialects.
 */
/**
 * Recursively null every value whose key matches a masked column, at any depth.
 * Used for realtime payloads: CDC gives clean row objects, but LISTEN/NOTIFY
 * payloads are shaped by a customer-written trigger, so we cannot assume where
 * the row sits and must walk the whole structure.
 */
function maskDeep<T>(value: T, masked: Set<string>): T {
  if (masked.size === 0 || value == null) return value;
  if (Array.isArray(value)) return value.map((v) => maskDeep(v, masked)) as unknown as T;
  if (typeof value === "object") {
    const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
    for (const k of Object.keys(out)) {
      out[k] = masked.has(k) ? null : maskDeep(out[k], masked);
    }
    return out as unknown as T;
  }
  return value;
}

@WebSocketGateway({ namespace: '/realtime', cors: { origin: true, credentials: true } })
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly log = new Logger(RealtimeGateway.name);
  private readonly subs = new Map<string, SubState>();
  @WebSocketServer() server!: Server;

  constructor(
    private readonly jwt: JwtService,
    private readonly cfg: AppConfigService,
    private readonly conns: ConnectionsService,
    private readonly rbac: RbacService,
    private readonly crypto: CryptoService,
    private readonly masks: ColumnMasksService,
    private readonly prisma: PrismaService,
    private readonly cdc: CdcService,
  ) {}

  async handleConnection(client: AuthedSocket) {
    try {
      const token = (client.handshake.auth?.token ?? client.handshake.headers['authorization']?.toString().replace(/^Bearer /, '')) as string;
      if (!token) throw new UnauthorizedException();
      const payload = await this.jwt.verifyAsync<{ sub: string }>(token, { secret: this.cfg.jwtAccessSecret });
      client.userId = payload.sub;
    } catch (e) {
      this.log.warn(`WS auth failed: ${(e as Error).message}`);
      client.disconnect(true);
    }
  }

  async handleDisconnect(client: AuthedSocket) {
    for (const [key, st] of this.subs.entries()) {
      if (key.startsWith(`${client.id}:`)) {
        if (st.cdcUnsub) await st.cdcUnsub().catch(() => {});
        if (st.pgClient) await st.pgClient.end().catch(() => {});
        if (st.pollTimer) clearInterval(st.pollTimer);
        this.subs.delete(key);
      }
    }
  }

  @SubscribeMessage('subscribe')
  async subscribe(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() data: { connectionId: string; schema: string; table: string },
  ) {
    if (!client.userId) return { ok: false, error: 'unauthorized' };
    const role = await this.rbac.effectiveRole(client.userId, data.connectionId);
    if (!role) return { ok: false, error: 'forbidden' };

    const conn = await this.prisma.connection.findUnique({ where: { id: data.connectionId } });
    if (!conn) return { ok: false, error: 'not_found' };
    const key = `${client.id}:${data.connectionId}:${data.schema}.${data.table}`;
    client.join(key);

    // SECURITY: live updates stream real row values, so they must respect this
    // subscriber's column masks exactly like the grid does. Without this, a
    // masked user could just watch the table and read masked columns as they
    // changed. Resolved once per subscription; owners have no masks so this is
    // empty for them.
    const masked = await this.masks.maskedColumnNames(client.userId, data.connectionId);

    // Preferred path: logical-replication CDC. Sub-second latency with exact
    // before/after row images and no user-installed trigger. Only used when the
    // server has wal_level=logical and we can publish the table; otherwise we
    // fall through to LISTEN/NOTIFY and then polling.
    if (conn.dialect === Dialect.POSTGRES) {
      try {
        const unsub = await this.cdc.subscribe(data.connectionId, data.schema, data.table, (change) => {
          client.emit('change', {
            schema: change.schema,
            table: change.table,
            mode: 'cdc',
            payload: {
              op: change.op,
              // Mask the before/after images — these are real row values.
              new: maskDeep(change.new, masked),
              old: maskDeep(change.old, masked),
              lsn: change.lsn,
            },
          });
        });
        this.subs.set(key, { cdcUnsub: unsub });
        return { ok: true, mode: 'cdc' };
      } catch (e) {
        this.log.debug(`CDC unavailable for ${key}, falling back: ${(e as Error).message}`);
      }
    }

    if (conn.dialect === Dialect.POSTGRES) {
      const creds = await this.crypto.decryptJson<ConnectionCredentials>(conn.credentialsCt, `conn:${conn.id}`);
      const pg = new PgClient({
        host: creds.host, port: creds.port ?? 5432,
        user: creds.user, password: creds.password, database: creds.database,
      });
      try {
        await pg.connect();
        const channel = `dbdash_${data.schema}_${data.table}`.toLowerCase().replace(/[^a-z0-9_]/g, '_');
        await pg.query(`LISTEN ${channel}`);
        pg.on('notification', (msg) => {
          // The payload comes from a trigger the customer wrote, so its shape is
          // arbitrary — parse it and null out anything named like a masked
          // column, at any depth. If it isn't JSON we can't inspect it, so it's
          // dropped rather than forwarded blind (fail closed) when masks apply.
          let payload: unknown = msg.payload;
          if (masked.size > 0) {
            try {
              payload = maskDeep(JSON.parse(msg.payload ?? 'null'), masked);
            } catch {
              this.log.warn(
                `Dropping non-JSON NOTIFY payload on ${key} — cannot apply column masks to it.`,
              );
              return;
            }
          }
          client.emit('change', { schema: data.schema, table: data.table, payload });
        });
        this.subs.set(key, { pgClient: pg });
        return { ok: true, mode: 'listen', channel };
      } catch (e) {
        await pg.end().catch(() => {});
        this.log.warn(`PG LISTEN failed, falling back to polling: ${(e as Error).message}`);
      }
    }

    // Polling fallback.
    let lastCount = -1;
    const tick = async () => {
      try {
        const role2 = await this.rbac.effectiveRole(client.userId!, data.connectionId);
        const drv = await this.conns.buildDriverForRole(data.connectionId, role2 ?? Role.VIEWER);
        try {
          const r = await drv.runRawQuery(`SELECT COUNT(*) AS c FROM ${data.schema}.${data.table}`);
          const c = Number((r.rows[0] as any)?.c ?? 0);
          if (c !== lastCount) {
            lastCount = c;
            client.emit('change', { schema: data.schema, table: data.table, payload: { rowCount: c } });
          }
        } finally { await drv.close().catch(() => {}); }
      } catch (e) {
        this.log.debug(`poll err: ${(e as Error).message}`);
      }
    };
    const timer = setInterval(tick, 5_000);
    this.subs.set(key, { pollTimer: timer });
    void tick();
    return { ok: true, mode: 'poll' };
  }

  @SubscribeMessage('unsubscribe')
  async unsubscribe(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() data: { connectionId: string; schema: string; table: string },
  ) {
    const key = `${client.id}:${data.connectionId}:${data.schema}.${data.table}`;
    const st = this.subs.get(key);
    if (st?.cdcUnsub) await st.cdcUnsub().catch(() => {});
    if (st?.pgClient) await st.pgClient.end().catch(() => {});
    if (st?.pollTimer) clearInterval(st.pollTimer);
    this.subs.delete(key);
    client.leave(key);
    return { ok: true };
  }
}
