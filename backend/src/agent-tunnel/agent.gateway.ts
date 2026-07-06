import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { randomBytes } from 'crypto';
import type { IncomingMessage } from 'http';
import { WebSocketServer, WebSocket, RawData } from 'ws';
import { AppConfigService } from '../config/config.service';
import { AgentConnection, AgentRegistry } from './agent-registry.service';

interface PairingPayload {
  sub: string; // userId
  agentId: string;
}

/** Extra state we hang off each raw socket. */
interface AgentSocket extends WebSocket {
  userId?: string;
  agentId?: string;
  conn?: AgentConnection;
  isAlive?: boolean;
}

const KEEPALIVE_INTERVAL_MS = 30_000;

/**
 * Raw `ws` server mounted on the shared HTTP server at `/agent-ws`. This is NOT
 * a socket.io gateway — the Go agent speaks plain WebSocket with our own
 * JSON(control)+binary(data) framing (see AGENT_TUNNEL_PROTOCOL.md).
 *
 * Handshake: agent connects to `/agent-ws?token=<pairingToken>`. We verify the
 * JWT with `jwtAccessSecret`, extract `{ userId, agentId }`, wait for `hello`,
 * reply `ready` with a refresh secret, and register the connection.
 */
@Injectable()
export class AgentGateway implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(AgentGateway.name);
  private wss?: WebSocketServer;
  private keepalive?: NodeJS.Timeout;

  constructor(
    private readonly httpAdapterHost: HttpAdapterHost,
    private readonly jwt: JwtService,
    private readonly cfg: AppConfigService,
    private readonly registry: AgentRegistry,
  ) {}

  onModuleInit(): void {
    const server = this.httpAdapterHost.httpAdapter?.getHttpServer();
    if (!server) {
      this.log.error('No HTTP server available; agent WS endpoint not mounted');
      return;
    }

    this.wss = new WebSocketServer({ server, path: '/agent-ws' });
    this.wss.on('connection', (ws: AgentSocket, req) => this.handleConnection(ws, req));
    this.wss.on('error', (err) => this.log.error(`Agent WS server error: ${err.message}`));

    // Keepalive sweep: any socket that didn't answer the previous ping is dead.
    this.keepalive = setInterval(() => {
      if (!this.wss) return;
      for (const client of this.wss.clients) {
        const sock = client as AgentSocket;
        if (sock.isAlive === false) {
          sock.terminate();
          continue;
        }
        sock.isAlive = false;
        try {
          sock.ping();
        } catch {
          /* ignore */
        }
      }
    }, KEEPALIVE_INTERVAL_MS);
    this.keepalive.unref?.();

    this.log.log('Agent WS endpoint listening on /agent-ws');
  }

  onModuleDestroy(): void {
    if (this.keepalive) clearInterval(this.keepalive);
    this.wss?.close();
  }

  private async handleConnection(ws: AgentSocket, req: IncomingMessage): Promise<void> {
    // 1) Authenticate off the query-string pairing token.
    let payload: PairingPayload;
    try {
      const token = this.tokenFromRequest(req);
      if (!token) throw new Error('missing token');
      payload = await this.jwt.verifyAsync<PairingPayload>(token, {
        secret: this.cfg.jwtAccessSecret,
      });
      if (!payload.agentId || !payload.sub) throw new Error('token missing agentId');
    } catch (e) {
      this.log.warn(`Agent WS auth failed: ${(e as Error).message}`);
      this.rejectSocket(ws, 4401, 'unauthorized');
      return;
    }

    ws.userId = payload.sub;
    ws.agentId = payload.agentId;
    ws.isAlive = true;

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', (data: RawData, isBinary: boolean) => {
      this.handleMessage(ws, data, isBinary);
    });

    ws.on('close', () => {
      if (ws.conn) this.registry.deregister(ws.agentId!, ws.conn);
    });

    ws.on('error', (err) => {
      this.log.warn(`Agent ${ws.agentId} socket error: ${err.message}`);
    });
  }

  private handleMessage(ws: AgentSocket, data: RawData, isBinary: boolean): void {
    // Binary frames are tunnel data — route them to the connection's streams.
    if (isBinary) {
      if (!ws.conn) return; // data before `hello`/registration — ignore
      ws.conn.handleBinary(this.toBuffer(data));
      return;
    }

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(this.toBuffer(data).toString('utf8')) as Record<string, unknown>;
    } catch {
      this.log.debug(`Agent ${ws.agentId} sent malformed JSON frame`);
      return;
    }

    const t = msg.t;
    switch (t) {
      case 'hello':
        this.onHello(ws, msg);
        break;
      case 'ping':
        this.safeSend(ws, JSON.stringify({ t: 'pong' }));
        break;
      case 'pong':
        ws.isAlive = true;
        break;
      default:
        // opened/openerr/close belong to the connection's stream machinery.
        if (ws.conn) ws.conn.handleControl(msg);
        break;
    }
  }

  private onHello(ws: AgentSocket, msg: Record<string, unknown>): void {
    if (ws.conn) return; // already said hello — ignore duplicates
    const meta = {
      userId: ws.userId!,
      hostname: typeof msg.hostname === 'string' ? msg.hostname : undefined,
      os: typeof msg.os === 'string' ? msg.os : undefined,
      version: typeof msg.version === 'string' ? msg.version : undefined,
    };
    ws.conn = this.registry.register(ws.agentId!, ws, meta);

    // The refresh secret lets the agent reconnect without re-pairing. Agent C's
    // service persists a hash of it; here we just mint and return the raw value.
    const refreshSecret = randomBytes(32).toString('base64url');
    this.safeSend(
      ws,
      JSON.stringify({ t: 'ready', agentId: ws.agentId, refreshSecret }),
    );
    this.log.log(
      `Agent ${ws.agentId} ready (host=${meta.hostname ?? '?'} os=${meta.os ?? '?'})`,
    );
  }

  private tokenFromRequest(req: IncomingMessage): string | undefined {
    // `req.url` is path+query only (e.g. "/agent-ws?token=..."); base is a dummy.
    const url = new URL(req.url ?? '', 'http://localhost');
    return url.searchParams.get('token') ?? undefined;
  }

  private toBuffer(data: RawData): Buffer {
    if (Buffer.isBuffer(data)) return data;
    if (Array.isArray(data)) return Buffer.concat(data);
    return Buffer.from(data as ArrayBuffer);
  }

  private safeSend(ws: WebSocket, payload: string): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }

  private rejectSocket(ws: WebSocket, code: number, reason: string): void {
    try {
      ws.close(code, reason);
    } catch {
      ws.terminate();
    }
  }
}
