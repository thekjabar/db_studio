import { Module } from '@nestjs/common';
import { ConnectionsModule } from '../connections/connections.module';
import { RbacModule } from '../rbac/rbac.module';
import { AuthModule } from '../auth/auth.module';
import { RealtimeGateway } from './realtime.gateway';

@Module({
  imports: [ConnectionsModule, RbacModule, AuthModule],
  providers: [RealtimeGateway],
})
export class RealtimeModule {}
