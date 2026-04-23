import { Global, MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { QuotaService } from './quota.service';
import { RequestIdMiddleware } from './request-id.middleware';

@Global()
@Module({
  imports: [PrismaModule],
  providers: [QuotaService],
  exports: [QuotaService],
})
export class CommonModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
