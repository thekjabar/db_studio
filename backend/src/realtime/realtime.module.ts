import { Module } from '@nestjs/common';
import { ConnectionsModule } from '../connections/connections.module';
import { RbacModule } from '../rbac/rbac.module';
import { AuthModule } from '../auth/auth.module';
import { RealtimeGateway } from './realtime.gateway';
import { CdcService } from './cdc.service';

@Module({
  imports: [ConnectionsModule, RbacModule, AuthModule],
  providers: [RealtimeGateway, CdcService],
  exports: [CdcService],
})
export class RealtimeModule {}
