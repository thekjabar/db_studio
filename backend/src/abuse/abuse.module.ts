import { Module } from '@nestjs/common';
import { AbuseService } from './abuse.service';
import { OperatorAbuseController } from './abuse.controller';
import { OperatorModule } from '../operator/operator.module';

@Module({
  imports: [OperatorModule],
  controllers: [OperatorAbuseController],
  providers: [AbuseService],
  exports: [AbuseService],
})
export class AbuseModule {}
