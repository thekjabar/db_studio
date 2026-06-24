import { CanActivate, ExecutionContext, HttpException, Inject, Injectable, Optional, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import type Redis from 'ioredis';
import { ApiKeysService } from './api-keys.service';
import { AppConfigService } from '../config/config.service';
import { REDIS_CLIENT } from '../scheduler/scheduler.constants';

/**
 * Auth + rate limit for `/v1/*` routes. Accepts `Authorization: Bearer
 * dbs_live_…` and attaches `req.user` + `req.apiKey` so downstream guards
 * (RbacGuard etc.) see the same shape as JWT-authenticated requests.
 *
 * Rate limit: per-key sliding window via Redis INCR+EXPIRE. Falls back to an
 * in-process Map when Redis isn't configured — fine for single-pod dev, not
 * enforceable across replicas but never *less* strict than the configured
 * cap on a single pod.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly memoryCounts = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly apiKeys: ApiKeysService,
    private readonly cfg: AppConfigService,
    @Optional() @Inject(REDIS_CLIENT) private readonly redis: Redis | null = null,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const res = ctx.switchToHttp().getResponse<Response>();
    const header = req.header('authorization') ?? '';
    const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
    if (!match) throw new UnauthorizedException('Missing bearer token');
    const resolved = await this.apiKeys.resolveToken(match[1]);
    if (!resolved) throw new UnauthorizedException('Invalid API key');

    const limit = this.cfg.apiKeyRateLimit;
    const { current, resetAt } = await this.incrementWindow(resolved.keyId);
    res.setHeader('X-RateLimit-Limit', String(limit));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, limit - current)));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(resetAt / 1000)));
    if (current > limit) {
      const retryAfter = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      throw new HttpException(
        { message: `Rate limit exceeded (${limit}/min). Retry in ${retryAfter}s.` },
        429,
      );
    }

    (req as unknown as { user: { id: string } }).user = { id: resolved.userId };
    (req as unknown as { apiKey: typeof resolved }).apiKey = resolved;
    return true;
  }

  private async incrementWindow(keyId: string): Promise<{ current: number; resetAt: number }> {
    const bucketSeconds = 60;
    if (this.redis) {
      const bucket = Math.floor(Date.now() / 1000 / bucketSeconds);
      const redisKey = `dbs:rl:apikey:${keyId}:${bucket}`;
      const count = await this.redis.incr(redisKey);
      if (count === 1) {
        // First hit in this bucket — set the TTL so keys don't pile up.
        await this.redis.expire(redisKey, bucketSeconds * 2);
      }
      const resetAt = (bucket + 1) * bucketSeconds * 1000;
      return { current: count, resetAt };
    }

    // In-process fallback. Accurate enough for single-pod deployments.
    const now = Date.now();
    const entry = this.memoryCounts.get(keyId);
    if (!entry || entry.resetAt < now) {
      const resetAt = now + bucketSeconds * 1000;
      this.memoryCounts.set(keyId, { count: 1, resetAt });
      return { current: 1, resetAt };
    }
    entry.count += 1;
    return { current: entry.count, resetAt: entry.resetAt };
  }
}
