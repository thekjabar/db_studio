import { Module } from '@nestjs/common';
import { RetentionService } from './retention.service';
import { OperatorRetentionController } from './retention.controller';
import { OperatorModule } from '../operator/operator.module';

@Module({
  imports: [OperatorModule],
  controllers: [OperatorRetentionController],
  providers: [RetentionService],
  exports: [RetentionService],
})
export class RetentionModule {}
