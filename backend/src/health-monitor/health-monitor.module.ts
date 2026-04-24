import { Module } from '@nestjs/common';
import { ConnectionsModule } from '../connections/connections.module';
import { RbacModule } from '../rbac/rbac.module';
import { HealthMonitorController } from './health-monitor.controller';
import { HealthMonitorService } from './health-monitor.service';

@Module({
  imports: [ConnectionsModule, RbacModule],
  controllers: [HealthMonitorController],
  providers: [HealthMonitorService],
})
export class HealthMonitorModule {}
