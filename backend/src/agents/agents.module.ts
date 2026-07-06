import { Module } from '@nestjs/common';
import { AppConfigModule } from '../config/config.module';
import { AuthModule } from '../auth/auth.module';
import { AgentTunnelModule } from '../agent-tunnel/agent-tunnel.module';
import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';

/**
 * Agent management (deliverable C): CRUD for a user's local agents + minting
 * short-lived pairing tokens. Reads live online status from AgentRegistry
 * (exported by AgentTunnelModule). AuthModule provides the JwtModule used to
 * sign pairing tokens with jwtAccessSecret (same secret the gateway verifies).
 */
@Module({
  imports: [AppConfigModule, AuthModule, AgentTunnelModule],
  controllers: [AgentsController],
  providers: [AgentsService],
})
export class AgentsModule {}
