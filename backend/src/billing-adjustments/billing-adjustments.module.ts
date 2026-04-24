import { Module } from '@nestjs/common';
import { BillingAdjustmentsService } from './billing-adjustments.service';
import { BillingAdjustmentsController } from './billing-adjustments.controller';
import { OperatorModule } from '../operator/operator.module';

@Module({
  imports: [OperatorModule],
  controllers: [BillingAdjustmentsController],
  providers: [BillingAdjustmentsService],
  exports: [BillingAdjustmentsService],
})
export class BillingAdjustmentsModule {}
