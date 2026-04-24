import { Module } from '@nestjs/common';
import { EmailTemplatesService } from './email-templates.service';
import { OperatorEmailTemplatesController } from './email-templates.controller';
import { OperatorModule } from '../operator/operator.module';

@Module({
  imports: [OperatorModule],
  controllers: [OperatorEmailTemplatesController],
  providers: [EmailTemplatesService],
  exports: [EmailTemplatesService],
})
export class EmailTemplatesModule {}
