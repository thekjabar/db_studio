import { Global, Module } from '@nestjs/common';
import { EmailService } from './email.service';

/**
 * EmailService only depends on the global AppConfigService, so exposing it as a
 * @Global module lets any feature (invitations, billing, etc.) send mail
 * without importing SchedulerModule — which would create an import cycle,
 * since SchedulerModule imports ConnectionsModule.
 */
@Global()
@Module({
  providers: [EmailService],
  exports: [EmailService],
})
export class EmailModule {}
