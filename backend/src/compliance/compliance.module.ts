import { Module } from '@nestjs/common';
import { ComplianceController } from './compliance.controller';
import { ComplianceService } from './compliance.service';
import { AdminGuard } from '../auth/guards/admin.guard';

@Module({
  controllers: [ComplianceController],
  providers: [ComplianceService, AdminGuard],
})
export class ComplianceModule {}
