import { Module } from '@nestjs/common';
import { ConnectionsModule } from '../connections/connections.module';
import { AuditModule } from '../audit/audit.module';
import { RbacModule } from '../rbac/rbac.module';
import { SlowQueryModule } from '../slow-query/slow-query.module';
import { QueryController } from './query.controller';
import { SqlClassifierService } from './sql-classifier.service';
import { ExplainService } from './explain.service';
import { SavedQueriesController } from './saved-queries.controller';
import { SavedQueriesService } from './saved-queries.service';

@Module({
  imports: [ConnectionsModule, AuditModule, RbacModule, SlowQueryModule],
  controllers: [QueryController, SavedQueriesController],
  providers: [SqlClassifierService, ExplainService, SavedQueriesService],
})
export class QueryModule {}
