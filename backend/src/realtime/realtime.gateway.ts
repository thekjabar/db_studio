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
import { PrismaService } from '../prisma/prisma.service';
import { ConnectionCredentials } from '../drivers/driver.interface';

interface AuthedSocket extends Socket { userId?: string }

interface SubState {
  pgClient?: PgClient;
  pollTimer?: NodeJS.Timeout;
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
    private readonly prisma: PrismaService,
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

    if (conn.dialect === Dialect.POSTGRES) {
      const creds = this.crypto.decryptJson<ConnectionCredentials>(conn.credentialsCt, `conn:${conn.id}`);
      const pg = new PgClient({
        host: creds.host, port: creds.port ?? 5432,
        user: creds.user, password: creds.password, database: creds.database,
      });
      try {
        await pg.connect();
        const channel = `dbdash_${data.schema}_${data.table}`.toLowerCase().replace(/[^a-z0-9_]/g, '_');
        await pg.query(`LISTEN ${channel}`);
        pg.on('notification', (msg) => {
          client.emit('change', { schema: data.schema, table: data.table, payload: msg.payload });
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
    if (st?.pgClient) await st.pgClient.end().catch(() => {});
    if (st?.pollTimer) clearInterval(st.pollTimer);
    this.subs.delete(key);
    client.leave(key);
    return { ok: true };
  }
}
