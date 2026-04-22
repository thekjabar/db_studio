import { Module } from '@nestjs/common';
import { ConnectionsModule } from '../connections/connections.module';
import { AuditModule } from '../audit/audit.module';
import { RbacModule } from '../rbac/rbac.module';
import { QueryController } from './query.controller';
import { SqlClassifierService } from './sql-classifier.service';
import { SavedQueriesController } from './saved-queries.controller';
import { SavedQueriesService } from './saved-queries.service';

@Module({
  imports: [ConnectionsModule, AuditModule, RbacModule],
  controllers: [QueryController, SavedQueriesController],
  providers: [SqlClassifierService, SavedQueriesService],
})
export class QueryModule {}
