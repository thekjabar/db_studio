import { Module } from '@nestjs/common';
import { AdminController, MetricsController } from './admin.controller';
import { AdminService } from './admin.service';
import { MetricsService } from './metrics.service';
import { AdminGuard } from '../auth/guards/admin.guard';

@Module({
  controllers: [AdminController, MetricsController],
  providers: [AdminService, MetricsService, AdminGuard],
  exports: [MetricsService],
})
export class AdminModule {}
