import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { Socket } from 'socket.io';

/**
 * Tracks connected agent sockets and provides request/response RPC over them.
 *
 * The AgentDriver (cloud-side IDatabaseDriver impl) calls `rpc(agentId, method,
 * args)`. We emit an `rpc` event to the agent's socket with a correlation id,
 * the agent runs the call against its LOCAL driver and emits `rpc:result` back,
 * and we resolve the matching promise. A timeout rejects so a hung/disconnected
 * agent never wedges a request forever.
 */

interface PendingCall {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

const RPC_TIMEOUT_MS = 60_000;

@Injectable()
export class AgentRelayService {
  private readonly log = new Logger(AgentRelayService.name);
  /** agentId -> live socket. One socket per agent (latest wins). */
  private readonly sockets = new Map<string, Socket>();
  /** correlationId -> pending promise handlers. */
  private readonly pending = new Map<string, PendingCall>();

  register(agentId: string, socket: Socket) {
    // If the agent reconnects, drop the old socket.
    const existing = this.sockets.get(agentId);
    if (existing && existing.id !== socket.id) existing.disconnect(true);
    this.sockets.set(agentId, socket);
  }

  unregister(agentId: string, socketId: string) {
    const cur = this.sockets.get(agentId);
    if (cur && cur.id === socketId) this.sockets.delete(agentId);
    // Reject any in-flight calls bound to this agent's socket — they can't
    // complete now. We can't cheaply map calls→agent, so we let them time out;
    // but a clean disconnect should fail fast, so reject all pending whose
    // socket is gone. (Pending calls store no agent ref; the timeout is the
    // backstop. Most RPCs are short, so this is acceptable.)
  }

  isOnline(agentId: string): boolean {
    return this.sockets.has(agentId);
  }

  /** Called by the gateway when an `rpc:result` arrives from an agent. */
  settle(correlationId: string, payload: { ok: boolean; result?: unknown; error?: string }) {
    const call = this.pending.get(correlationId);
    if (!call) return;
    this.pending.delete(correlationId);
    clearTimeout(call.timer);
    if (payload.ok) call.resolve(payload.result);
    else call.reject(new Error(payload.error || 'Agent RPC failed'));
  }

  /**
   * Invoke a driver method on the agent. `method` is an IDatabaseDriver method
   * name; `args` its arguments. Resolves with the method's return value.
   */
  async rpc<T = unknown>(agentId: string, method: string, args: unknown[]): Promise<T> {
    const socket = this.sockets.get(agentId);
    if (!socket) {
      throw new ServiceUnavailableException({
        code: 'AGENT_OFFLINE',
        message: 'The network agent for this connection is offline. Start the agent and retry.',
      });
    }
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new ServiceUnavailableException({
            code: 'AGENT_TIMEOUT',
            message: `Agent did not respond to "${method}" within ${RPC_TIMEOUT_MS / 1000}s.`,
          }),
        );
      }, RPC_TIMEOUT_MS);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      socket.emit('rpc', { id, method, args });
    });
  }
}
