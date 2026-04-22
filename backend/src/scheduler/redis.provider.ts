import { FactoryProvider, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { AppConfigService } from '../config/config.service';
import { REDIS_CLIENT } from './scheduler.constants';

/**
 * Shared ioredis client for bullmq. We follow bullmq's requirement:
 * `maxRetriesPerRequest: null` so blocking commands (BRPOPLPUSH etc.) don't
 * time out under normal wait. When `REDIS_URL` isn't configured the provider
 * resolves to null — downstream services check `emailEnabled`/`schedulerEnabled`
 * and skip registering queues.
 */
export const redisProvider: FactoryProvider = {
  provide: REDIS_CLIENT,
  inject: [AppConfigService],
  useFactory: (cfg: AppConfigService) => {
    if (!cfg.redisUrl) {
      new Logger('Scheduler').log('Redis disabled (no REDIS_URL) — scheduled queries will not run');
      return null;
    }
    const client = new Redis(cfg.redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
    });
    client.on('error', (err) => new Logger('Redis').error(`Redis error: ${err.message}`));
    return client;
  },
};
