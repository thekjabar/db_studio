import { Module } from '@nestjs/common';
import { ConnectionsModule } from '../connections/connections.module';
import { AuditModule } from '../audit/audit.module';
import { SchedulerModule } from '../scheduler/scheduler.module';
import { RbacModule } from '../rbac/rbac.module';
import { ExportsController } from './exports.controller';
import { ExportsService } from './exports.service';

@Module({
  imports: [ConnectionsModule, AuditModule, SchedulerModule, RbacModule],
  controllers: [ExportsController],
  providers: [ExportsService],
})
export class ExportsModule {}
