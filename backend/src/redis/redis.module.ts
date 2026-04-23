import { Global, Module } from '@nestjs/common';
import { redisProvider } from '../scheduler/redis.provider';

/**
 * Shared ioredis client. Marked Global so every module can inject
 * `REDIS_CLIENT` without repeating this import.
 */
@Global()
@Module({
  providers: [redisProvider],
  exports: [redisProvider],
})
export class RedisModule {}
