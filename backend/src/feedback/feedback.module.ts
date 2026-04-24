import { Module } from '@nestjs/common';
import { FeedbackService } from './feedback.service';
import { FeedbackController, OperatorFeedbackController } from './feedback.controller';
import { SchedulerModule } from '../scheduler/scheduler.module';
import { OperatorModule } from '../operator/operator.module';

@Module({
  imports: [SchedulerModule, OperatorModule],
  controllers: [FeedbackController, OperatorFeedbackController],
  providers: [FeedbackService],
  exports: [FeedbackService],
})
export class FeedbackModule {}
