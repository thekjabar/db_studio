import { Module } from '@nestjs/common';
import { PublicStatusController, IncidentsAdminController } from './status.controller';
import { StatusService } from './status.service';
import { AdminGuard } from '../auth/guards/admin.guard';

@Module({
  controllers: [PublicStatusController, IncidentsAdminController],
  providers: [StatusService, AdminGuard],
})
export class StatusModule {}
