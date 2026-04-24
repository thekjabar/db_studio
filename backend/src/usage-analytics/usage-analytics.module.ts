import { Module } from '@nestjs/common';
import { UsageAnalyticsService } from './usage-analytics.service';
import { OperatorAnalyticsController } from './usage-analytics.controller';
import { OperatorModule } from '../operator/operator.module';

@Module({
  imports: [OperatorModule],
  controllers: [OperatorAnalyticsController],
  providers: [UsageAnalyticsService],
  exports: [UsageAnalyticsService],
})
export class UsageAnalyticsModule {}
