import { Injectable, Logger } from '@nestjs/common';
import type { WebSocket } from 'ws';

/**
 * A live tunnel stream over the agent WebSocket. Mirrors the surface a
 * `net.Socket` consumer needs: write bytes, be told when bytes arrive, be told
 * when the far end closes, and close it yourself.
 */
export interface AgentStream {
  write(buf: Buffer): void;
  onData(cb: (buf: Buffer) => void): void;
  onClose(cb: () => void): void;
  close(): void;
}

interface PendingOpen {
  resolve: (stream: AgentStream) => void;
  reject: (err: Error) => void;
}

interface StreamState {
  streamId: string;
  onData?: (buf: Buffer) => void;
  onClose?: () => void;
  closed: boolean;
}

interface AgentMeta {
  userId: string;
  hostname?: string;
  os?: string;
  version?: string;
}

/** Max concurrent streams per agent — bounds resource use per the protocol's
 *  "cap concurrent streams" security note. */
const MAX_STREAMS_PER_AGENT = 256;
/** Reject oversized inbound data frames rather than buffer them. */
const MAX_FRAME_BYTES = 8 * 1024 * 1024;

/**
 * Wraps a single agent's raw WebSocket and multiplexes many TCP streams over it
 * using the control(JSON)+binary framing from AGENT_TUNNEL_PROTOCOL.md.
 */
export class AgentConnection {
  private readonly log = new Logger(AgentConnection.name);
  private seq = 0;
  private readonly streams = new Map<string, StreamState>();
  private readonly pending = new Map<string, PendingOpen>();
  private torn = false;

  constructor(
    readonly agentId: string,
    private readonly ws: WebSocket,
    readonly meta: AgentMeta,
  ) {}

  /** Ask the agent to dial `host:port`; resolves once it replies `opened`. */
  openStream(host: string, port: number): Promise<AgentStream> {
    if (this.torn) {
      return Promise.reject(new Error('agent connection closed'));
    }
    if (this.streams.size >= MAX_STREAMS_PER_AGENT) {
      return Promise.reject(new Error('agent stream limit reached'));
    }
    const streamId = `s${++this.seq}`;
    const state: StreamState = { streamId, closed: false };
    this.streams.set(streamId, state);

    return new Promise<AgentStream>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pending.delete(streamId)) {
          this.streams.delete(streamId);
          reject(new Error(`agent open timed out for ${host}:${port}`));
        }
      }, 15_000);

      this.pending.set(streamId, {
        resolve: (stream) => {
          clearTimeout(timeout);
          resolve(stream);
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
      });

      try {
        this.sendControl({ t: 'open', streamId, host, port });
      } catch (err) {
        clearTimeout(timeout);
        this.pending.delete(streamId);
        this.streams.delete(streamId);
        reject(err as Error);
      }
    });
  }

  /** Route a JSON control frame received from the agent. */
  handleControl(msg: Record<string, unknown>): void {
    const t = msg.t;
    switch (t) {
      case 'opened': {
        const streamId = String(msg.streamId ?? '');
        const pend = this.pending.get(streamId);
        const state = this.streams.get(streamId);
        if (!pend || !state) return;
        this.pending.delete(streamId);
        pend.resolve(this.makeStream(state));
        break;
      }
      case 'openerr': {
        const streamId = String(msg.streamId ?? '');
        const pend = this.pending.get(streamId);
        if (!pend) return;
        this.pending.delete(streamId);
        this.streams.delete(streamId);
        pend.reject(new Error(String(msg.error ?? 'agent failed to open stream')));
        break;
      }
      case 'close': {
        const streamId = String(msg.streamId ?? '');
        this.finalizeStream(streamId);
        break;
      }
      default:
        // ping/pong/hello are handled by the gateway, not here.
        break;
    }
  }

  /** Route an inbound binary data frame (4-byte len + streamId + payload). */
  handleBinary(frame: Buffer): void {
    if (frame.length > MAX_FRAME_BYTES) {
      this.log.warn(`Dropping oversized frame (${frame.length} bytes) from agent ${this.agentId}`);
      return;
    }
    if (frame.length < 4) return;
    const idLen = frame.readUInt32BE(0);
    if (idLen === 0 || frame.length < 4 + idLen) return;
    const streamId = frame.toString('utf8', 4, 4 + idLen);
    const payload = frame.subarray(4 + idLen);
    const state = this.streams.get(streamId);
    if (!state || state.closed) return;
    state.onData?.(payload);
  }

  /** Tear down every stream — called when the WS drops. */
  teardown(): void {
    if (this.torn) return;
    this.torn = true;
    for (const pend of this.pending.values()) {
      pend.reject(new Error('agent disconnected'));
    }
    this.pending.clear();
    for (const state of this.streams.values()) {
      if (!state.closed) {
        state.closed = true;
        state.onClose?.();
      }
    }
    this.streams.clear();
  }

  private makeStream(state: StreamState): AgentStream {
    return {
      write: (buf: Buffer) => {
        if (state.closed || this.torn) return;
        this.sendData(state.streamId, buf);
      },
      onData: (cb) => {
        state.onData = cb;
      },
      onClose: (cb) => {
        state.onClose = cb;
      },
      close: () => {
        if (state.closed) return;
        state.closed = true;
        this.streams.delete(state.streamId);
        // Tell the agent to drop its TCP socket for this stream.
        try {
          this.sendControl({ t: 'close', streamId: state.streamId });
        } catch {
          /* WS already gone — nothing to do */
        }
      },
    };
  }

  /** Agent asked us to close a stream: notify the local consumer. */
  private finalizeStream(streamId: string): void {
    const state = this.streams.get(streamId);
    if (!state || state.closed) return;
    state.closed = true;
    this.streams.delete(streamId);
    state.onClose?.();
  }

  private sendControl(msg: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(msg));
  }

  private sendData(streamId: string, payload: Buffer): void {
    const idBuf = Buffer.from(streamId, 'utf8');
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32BE(idBuf.length, 0);
    this.ws.send(Buffer.concat([header, idBuf, payload]));
  }
}

/**
 * Tracks which agents are currently connected. One entry per `agentId`; a new
 * connection replaces (and tears down) any prior one for the same agent.
 */
@Injectable()
export class AgentRegistry {
  private readonly log = new Logger(AgentRegistry.name);
  private readonly agents = new Map<string, AgentConnection>();

  register(agentId: string, ws: WebSocket, meta: AgentMeta): AgentConnection {
    // One agent per id — replace the old socket if it's still around.
    const existing = this.agents.get(agentId);
    if (existing) {
      this.log.log(`Replacing existing connection for agent ${agentId}`);
      existing.teardown();
    }
    const conn = new AgentConnection(agentId, ws, meta);
    this.agents.set(agentId, conn);
    this.log.log(`Agent ${agentId} online (${this.agents.size} total)`);
    return conn;
  }

  /**
   * Remove an agent, but only if the tracked connection is still `conn` — avoids
   * a late-closing old socket evicting the replacement that took its place.
   */
  deregister(agentId: string, conn: AgentConnection): void {
    const current = this.agents.get(agentId);
    if (current !== conn) return;
    this.agents.delete(agentId);
    conn.teardown();
    this.log.log(`Agent ${agentId} offline (${this.agents.size} total)`);
  }

  isOnline(agentId: string): boolean {
    return this.agents.has(agentId);
  }

  get(agentId: string): AgentConnection | undefined {
    return this.agents.get(agentId);
  }
}
