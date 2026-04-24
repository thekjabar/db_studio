import { Module } from '@nestjs/common';
import { InviteCodesService } from './invite-codes.service';
import {
  WaitlistController,
  OperatorInviteCodesController,
  OperatorWaitlistController,
} from './invite-codes.controller';
import { OperatorModule } from '../operator/operator.module';

@Module({
  imports: [OperatorModule],
  controllers: [WaitlistController, OperatorInviteCodesController, OperatorWaitlistController],
  providers: [InviteCodesService],
  exports: [InviteCodesService],
})
export class InviteCodesModule {}
