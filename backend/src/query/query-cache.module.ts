import { Global, Module } from '@nestjs/common';
import { QueryCacheService } from './query-cache.service';

/**
 * The query cache is injected from two places that would otherwise form an
 * import cycle: QueryModule (read path — cache lookups on SELECT) and
 * ConnectionsModule (write path — invalidation on row mutations). Marking it
 * Global lets both inject `QueryCacheService` without importing each other.
 *
 * It depends only on the global Redis client and AppConfigService, so it has no
 * inbound module dependencies of its own.
 */
@Global()
@Module({
  providers: [QueryCacheService],
  exports: [QueryCacheService],
})
export class QueryCacheModule {}
