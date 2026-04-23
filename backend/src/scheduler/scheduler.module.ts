import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { RbacModule } from '../rbac/rbac.module';
import { ConnectionsModule } from '../connections/connections.module';
import { AppConfigService } from '../config/config.service';
import { QueuesService } from './queues.service';
import { EmailService } from './email.service';
import { SchedulerWorker } from './scheduler.worker';
import { SchedulerService } from './scheduler.service';
import { SchedulerController } from './scheduler.controller';

@Module({
  imports: [PrismaModule, RbacModule, ConnectionsModule],
  controllers: [SchedulerController],
  providers: [
    AppConfigService,
    QueuesService,
    EmailService,
    SchedulerWorker,
    SchedulerService,
  ],
  exports: [SchedulerService, EmailService],
})
export class SchedulerModule {}
