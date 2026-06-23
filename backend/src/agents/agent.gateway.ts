import { Logger } from '@nestjs/common';
import {
  ConnectedSocket, MessageBody, OnGatewayConnection, OnGatewayDisconnect,
  SubscribeMessage, WebSocketGateway,
} from '@nestjs/websockets';
import { Socket } from 'socket.io';
import { AgentsService } from './agents.service';
import { AgentRelayService } from './agent-relay.service';

interface AgentSocket extends Socket {
  agentId?: string;
}

/**
 * WS gateway at /agent — where network agents connect (outbound from the
 * customer network). Auth is by pairing token, NOT a user JWT.
 *
 * Flow:
 *   1) Agent connects with `auth: { token: "agt_live_..." , version }`.
 *   2) We resolve the token → mark the agent online.
 *   3) The cloud sends `rpc` events (driver calls); the agent replies with
 *      `rpc:result`. The agent also emits periodic `heartbeat`.
 */
@WebSocketGateway({ namespace: '/agent', cors: { origin: true, credentials: true } })
export class AgentGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly log = new Logger(AgentGateway.name);

  constructor(
    private readonly agents: AgentsService,
    private readonly relay: AgentRelayService,
  ) {}

  async handleConnection(client: AgentSocket) {
    try {
      const token =
        (client.handshake.auth?.token as string) ??
        client.handshake.headers['authorization']?.toString().replace(/^Bearer /, '');
      const version = client.handshake.auth?.version as string | undefined;
      const resolved = await this.agents.resolveToken(token);
      if (!resolved) {
        this.log.warn('agent connect rejected: bad token');
        client.disconnect(true);
        return;
      }
      client.agentId = resolved.agentId;
      this.relay.register(resolved.agentId, client);
      await this.agents.setStatus(resolved.agentId, 'online', version);
      this.log.log(`agent ${resolved.agentId} connected`);
      client.emit('ready', { ok: true });
    } catch (e) {
      this.log.warn(`agent connect error: ${(e as Error).message}`);
      client.disconnect(true);
    }
  }

  async handleDisconnect(client: AgentSocket) {
    if (!client.agentId) return;
    this.relay.unregister(client.agentId, client.id);
    await this.agents.setStatus(client.agentId, 'offline');
    this.log.log(`agent ${client.agentId} disconnected`);
  }

  /** Agent returns the result of an RPC the cloud sent. */
  @SubscribeMessage('rpc:result')
  onResult(
    @ConnectedSocket() client: AgentSocket,
    @MessageBody() data: { id: string; ok: boolean; result?: unknown; error?: string },
  ) {
    if (!client.agentId || !data?.id) return;
    this.relay.settle(data.id, data);
  }

  @SubscribeMessage('heartbeat')
  async onHeartbeat(@ConnectedSocket() client: AgentSocket) {
    if (client.agentId) await this.agents.heartbeat(client.agentId);
    return { ok: true };
  }
}
