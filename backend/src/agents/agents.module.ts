import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AppConfigModule } from '../config/config.module';
import { AppConfigService } from '../config/config.service';
import { AgentTunnelModule } from '../agent-tunnel/agent-tunnel.module';
import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';

/**
 * Agent management (deliverable C): CRUD for a user's local agents + minting
 * short-lived pairing tokens. Reads live online status from AgentRegistry
 * (exported by AgentTunnelModule). Imports JwtModule directly (configured with
 * jwtAccessSecret) to sign pairing tokens — same reason as AgentTunnelModule,
 * avoiding an AuthModule import cycle. The global JwtAuthGuard still protects
 * these routes (it's registered app-wide by AuthModule).
 */
@Module({
  imports: [
    AppConfigModule,
    AgentTunnelModule,
    JwtModule.registerAsync({
      inject: [AppConfigService],
      useFactory: (cfg: AppConfigService) => ({ secret: cfg.jwtAccessSecret }),
    }),
  ],
  controllers: [AgentsController],
  providers: [AgentsService],
})
export class AgentsModule {}
