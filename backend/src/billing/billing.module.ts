import { Global, Module } from '@nestjs/common';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { BillingLifecycleService } from './billing-lifecycle.service';
import { PlanService } from './plan.service';
import { WaylClient } from './wayl.client';

/**
 * Customer subscription billing + Wayl payments. Global so the plan-gating
 * services (QuotaService, AiQuotaService) can inject PlanService to resolve a
 * workspace's effective tier without an import cycle. PrismaService and
 * AppConfigService come from their own @Global modules.
 */
@Global()
@Module({
  controllers: [BillingController],
  providers: [PlanService, WaylClient, BillingService, BillingLifecycleService],
  exports: [PlanService, BillingService],
})
export class BillingModule {}
