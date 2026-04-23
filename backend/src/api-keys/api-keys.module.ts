import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ConnectionsModule } from '../connections/connections.module';
import { RbacModule } from '../rbac/rbac.module';
import { QueryModule } from '../query/query.module';
import { ApiKeysController } from './api-keys.controller';
import { ApiKeysService } from './api-keys.service';
import { ApiKeyGuard } from './api-key.guard';
import { PublicApiController } from './public-api.controller';
import { SqlClassifierService } from '../query/sql-classifier.service';

@Module({
  imports: [PrismaModule, ConnectionsModule, RbacModule, QueryModule],
  controllers: [ApiKeysController, PublicApiController],
  providers: [ApiKeysService, ApiKeyGuard, SqlClassifierService],
  exports: [ApiKeysService, ApiKeyGuard],
})
export class ApiKeysModule {}
