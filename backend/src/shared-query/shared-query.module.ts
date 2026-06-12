import { Module } from '@nestjs/common';
import { SharedQueryService } from './shared-query.service';
import { SharedQueryController, PublicSharedQueryController } from './shared-query.controller';
import { ConnectionsModule } from '../connections/connections.module';
import { QueryModule } from '../query/query.module';
import { RbacModule } from '../rbac/rbac.module';

@Module({
  imports: [ConnectionsModule, QueryModule, RbacModule],
  controllers: [SharedQueryController, PublicSharedQueryController],
  providers: [SharedQueryService],
})
export class SharedQueryModule {}
