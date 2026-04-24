import { forwardRef, Module } from '@nestjs/common';
import { QueryReviewController } from './query-review.controller';
import { QueryReviewService } from './query-review.service';
import { RbacModule } from '../rbac/rbac.module';
import { ConnectionsModule } from '../connections/connections.module';
import { QueryModule } from '../query/query.module';

@Module({
  imports: [RbacModule, ConnectionsModule, forwardRef(() => QueryModule)],
  controllers: [QueryReviewController],
  providers: [QueryReviewService],
  exports: [QueryReviewService],
})
export class QueryReviewModule {}
