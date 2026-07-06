import { Module } from '@nestjs/common';
import { AppConfigModule } from '../config/config.module';
import { AuthModule } from '../auth/auth.module';
import { AgentRegistry } from './agent-registry.service';
import { AgentGateway } from './agent.gateway';
import { AgentTunnelService } from './agent-tunnel.service';

/**
 * Backend transport for the local-agent tunnel (deliverable B):
 *  - AgentGateway: raw `ws` endpoint at /agent-ws (JWT-paired agents connect out)
 *  - AgentRegistry: tracks online agents + multiplexes TCP streams over each WS
 *  - AgentTunnelService: `open()` mirroring SshTunnelService for ConnectionsService
 *
 * AuthModule re-exports JwtModule (configured with jwtAccessSecret), matching
 * the RealtimeModule wiring so the gateway can verify pairing tokens.
 */
@Module({
  imports: [AppConfigModule, AuthModule],
  providers: [AgentRegistry, AgentGateway, AgentTunnelService],
  exports: [AgentTunnelService, AgentRegistry],
})
export class AgentTunnelModule {}
