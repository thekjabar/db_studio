import { forwardRef, Module } from '@nestjs/common';
import { ConnectionsModule } from '../connections/connections.module';
import { AuditModule } from '../audit/audit.module';
import { RbacModule } from '../rbac/rbac.module';
import { SlowQueryModule } from '../slow-query/slow-query.module';
import { QueryController } from './query.controller';
import { SqlClassifierService } from './sql-classifier.service';
import { ExplainService } from './explain.service';
import { PerfInsightsService } from './perf-insights.service';
import { QueryCostService } from './query-cost.service';
import { SavedQueriesController } from './saved-queries.controller';
import { SavedQueriesService } from './saved-queries.service';
import { QueryReviewModule } from '../query-review/query-review.module';

@Module({
  imports: [
    ConnectionsModule,
    AuditModule,
    RbacModule,
    SlowQueryModule,
    forwardRef(() => QueryReviewModule),
  ],
  controllers: [QueryController, SavedQueriesController],
  providers: [SqlClassifierService, ExplainService, PerfInsightsService, QueryCostService, SavedQueriesService],
  exports: [SqlClassifierService],
})
export class QueryModule {}
