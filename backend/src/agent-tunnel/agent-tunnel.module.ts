import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AppConfigModule } from '../config/config.module';
import { AppConfigService } from '../config/config.service';
import { AgentRegistry } from './agent-registry.service';
import { AgentGateway } from './agent.gateway';
import { AgentTunnelService } from './agent-tunnel.service';

/**
 * Backend transport for the local-agent tunnel (deliverable B):
 *  - AgentGateway: raw `ws` endpoint at /agent-ws (JWT-paired agents connect out)
 *  - AgentRegistry: tracks online agents + multiplexes TCP streams over each WS
 *  - AgentTunnelService: `open()` mirroring SshTunnelService for ConnectionsService
 *
 * Imports JwtModule DIRECTLY (configured with jwtAccessSecret) rather than
 * AuthModule. ConnectionsModule imports this module so the driver can open agent
 * tunnels; pulling in the whole AuthModule here would close an import cycle
 * (ConnectionsModule -> AgentTunnelModule -> AuthModule -> ... -> ConnectionsModule)
 * that crashes at load with "Cannot access 'AuthModule' before initialization".
 */
@Module({
  imports: [
    AppConfigModule,
    JwtModule.registerAsync({
      inject: [AppConfigService],
      useFactory: (cfg: AppConfigService) => ({ secret: cfg.jwtAccessSecret }),
    }),
  ],
  providers: [AgentRegistry, AgentGateway, AgentTunnelService],
  exports: [AgentTunnelService, AgentRegistry],
})
export class AgentTunnelModule {}
