import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { RbacModule } from '../rbac/rbac.module';
import { SlowQueryController } from './slow-query.controller';
import { SlowQueryService } from './slow-query.service';

@Module({
  imports: [PrismaModule, RbacModule],
  controllers: [SlowQueryController],
  providers: [SlowQueryService],
  exports: [SlowQueryService],
})
export class SlowQueryModule {}
