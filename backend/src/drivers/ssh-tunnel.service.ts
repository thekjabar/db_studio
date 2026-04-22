import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { Client as SshClient } from 'ssh2';
import { createServer, Server, Socket } from 'net';
import { AddressInfo } from 'net';
import { SshTunnelConfig } from './driver.interface';

export interface OpenTunnel {
  localHost: string;
  localPort: number;
  close: () => Promise<void>;
}

@Injectable()
export class SshTunnelService {
  private readonly log = new Logger(SshTunnelService.name);

  async open(ssh: SshTunnelConfig, remoteHost: string, remotePort: number): Promise<OpenTunnel> {
    const client = await this.connect(ssh);
    const server = await this.listenLocal();
    const localPort = (server.address() as AddressInfo).port;

    // Each incoming connection on our loopback socket is forwarded through
    // the SSH session to the target DB host.
    server.on('connection', (socket: Socket) => {
      client.forwardOut(
        '127.0.0.1',
        localPort,
        remoteHost,
        remotePort,
        (err, stream) => {
          if (err) {
            this.log.warn(`SSH forwardOut failed: ${err.message}`);
            socket.destroy(err);
            return;
          }
          socket.pipe(stream).pipe(socket);
          stream.on('close', () => socket.destroy());
          socket.on('error', () => stream.destroy());
        },
      );
    });

    // If the SSH session dies unexpectedly, shut the local listener too.
    client.on('close', () => {
      try {
        server.close();
      } catch {
        /* ignore */
      }
    });

    return {
      localHost: '127.0.0.1',
      localPort,
      close: async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        try {
          client.end();
        } catch {
          /* ignore */
        }
      },
    };
  }

  private listenLocal(): Promise<Server> {
    return new Promise((resolve, reject) => {
      const server = createServer();
      server.on('error', reject);
      // Bind to loopback + port 0 so the OS picks a free port.
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve(server);
      });
    });
  }

  private connect(ssh: SshTunnelConfig): Promise<SshClient> {
    return new Promise((resolve, reject) => {
      const client = new SshClient();
      const timeout = setTimeout(() => {
        client.end();
        reject(new ServiceUnavailableException('SSH connection timed out'));
      }, 15_000);

      client.once('ready', () => {
        clearTimeout(timeout);
        resolve(client);
      });
      client.once('error', (err) => {
        clearTimeout(timeout);
        reject(new ServiceUnavailableException(`SSH connect failed: ${err.message}`));
      });

      const config: Record<string, unknown> = {
        host: ssh.host,
        port: ssh.port || 22,
        username: ssh.user,
        // Tighten defaults — avoids hanging forever if the server never hand-shakes.
        readyTimeout: 12_000,
        keepaliveInterval: 30_000,
      };
      if (ssh.authType === 'password') {
        config.password = ssh.password ?? '';
      } else {
        config.privateKey = ssh.privateKey ?? '';
        if (ssh.passphrase) config.passphrase = ssh.passphrase;
      }
      client.connect(config as never);
    });
  }
}
