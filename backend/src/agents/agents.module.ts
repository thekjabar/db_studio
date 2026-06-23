import { Module } from '@nestjs/common';
import { AgentsService } from './agents.service';
import { AgentRelayService } from './agent-relay.service';
import { AgentGateway } from './agent.gateway';
import { AgentsController } from './agents.controller';

/**
 * Network agents. Exports AgentsService + AgentRelayService so ConnectionsModule
 * can build an AgentDriver for agent-routed connections. Has no inbound module
 * dependencies (only the global Prisma), so importing it from ConnectionsModule
 * creates no cycle.
 */
@Module({
  controllers: [AgentsController],
  providers: [AgentsService, AgentRelayService, AgentGateway],
  exports: [AgentsService, AgentRelayService],
})
export class AgentsModule {}
