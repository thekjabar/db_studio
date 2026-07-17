import { Global, MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { QuotaService } from './quota.service';
import { EgressIpService } from './egress-ip.service';
import { SsrfGuardService } from './ssrf-guard.service';
import { RequestIdMiddleware } from './request-id.middleware';
import { MetricsMiddleware } from '../admin/metrics.middleware';
import { AdminModule } from '../admin/admin.module';

@Global()
@Module({
  imports: [PrismaModule, AdminModule],
  providers: [QuotaService, EgressIpService, SsrfGuardService],
  exports: [QuotaService, EgressIpService, SsrfGuardService],
})
export class CommonModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestIdMiddleware, MetricsMiddleware).forRoutes('*');
  }
}
