import { Module } from '@nestjs/common';
import { ConnectionsModule } from '../connections/connections.module';
import { AgentTunnelModule } from '../agent-tunnel/agent-tunnel.module';
import { RbacModule } from '../rbac/rbac.module';
import { AuthModule } from '../auth/auth.module';
import { RealtimeGateway } from './realtime.gateway';
import { CdcService } from './cdc.service';

@Module({
  imports: [ConnectionsModule, AgentTunnelModule, RbacModule, AuthModule],
  providers: [RealtimeGateway, CdcService],
  exports: [CdcService],
})
export class RealtimeModule {}
