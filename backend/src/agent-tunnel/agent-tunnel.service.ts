import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { createServer, Server, Socket, AddressInfo } from 'net';
import { OpenTunnel } from '../drivers/ssh-tunnel.service';
import { AgentRegistry, AgentStream } from './agent-registry.service';

/**
 * Local-agent counterpart to {@link SshTunnelService}. Instead of an SSH
 * `forwardOut`, each incoming loopback connection is bridged to a stream on the
 * user's local agent (see AGENT_TUNNEL_PROTOCOL.md). The DB drivers connect to
 * the returned `127.0.0.1:<port>` and are unaware a tunnel exists — identical
 * trick to the SSH tunnel, so `maybeOpenTunnel` can branch between the two.
 */
@Injectable()
export class AgentTunnelService {
  private readonly log = new Logger(AgentTunnelService.name);

  constructor(private readonly registry: AgentRegistry) {}

  async open(agentId: string, remoteHost: string, remotePort: number): Promise<OpenTunnel> {
    // Fail fast (and clearly) when the agent isn't paired/online — the driver
    // then surfaces a meaningful error instead of a generic connect timeout.
    if (!this.registry.isOnline(agentId)) {
      throw new ServiceUnavailableException(
        `Local agent is offline. Start the agent (agent.exe) on the machine that can reach ${remoteHost}:${remotePort}, then retry.`,
      );
    }

    const server = await this.listenLocal();
    const localPort = (server.address() as AddressInfo).port;

    server.on('connection', (socket: Socket) => {
      void this.bridge(agentId, remoteHost, remotePort, socket);
    });

    return {
      localHost: '127.0.0.1',
      localPort,
      close: async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    };
  }

  /** Wire one loopback socket to a freshly-opened agent stream, both ways. */
  private async bridge(
    agentId: string,
    remoteHost: string,
    remotePort: number,
    socket: Socket,
  ): Promise<void> {
    const conn = this.registry.get(agentId);
    if (!conn) {
      socket.destroy(new Error('local agent offline'));
      return;
    }

    let stream: AgentStream;
    try {
      stream = await conn.openStream(remoteHost, remotePort);
    } catch (err) {
      this.log.warn(`Agent openStream failed for ${remoteHost}:${remotePort}: ${(err as Error).message}`);
      socket.destroy(err as Error);
      return;
    }

    // Guard against double-teardown when both ends close near-simultaneously.
    let closed = false;
    const shutdown = () => {
      if (closed) return;
      closed = true;
      stream.close();
      socket.destroy();
    };

    // Agent → local driver.
    stream.onData((buf) => {
      socket.write(buf);
    });
    stream.onClose(() => {
      if (closed) return;
      closed = true;
      socket.end();
    });

    // Local driver → agent.
    socket.on('data', (buf: Buffer) => {
      stream.write(buf);
    });
    socket.on('end', () => shutdown());
    socket.on('close', () => shutdown());
    socket.on('error', () => shutdown());
  }

  private listenLocal(): Promise<Server> {
    return new Promise((resolve, reject) => {
      const server = createServer();
      server.on('error', reject);
      // Bind loopback + port 0 so the OS picks a free port — same as SshTunnel.
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve(server);
      });
    });
  }
}
