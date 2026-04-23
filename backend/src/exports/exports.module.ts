import { Module } from '@nestjs/common';
import { ConnectionsModule } from '../connections/connections.module';
import { AuditModule } from '../audit/audit.module';
import { SchedulerModule } from '../scheduler/scheduler.module';
import { ExportsController } from './exports.controller';
import { ExportsService } from './exports.service';

@Module({
  imports: [ConnectionsModule, AuditModule, SchedulerModule],
  controllers: [ExportsController],
  providers: [ExportsService],
})
export class ExportsModule {}
