import { Controller, Get, Inject, Optional, ServiceUnavailableException } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type Redis from 'ioredis';
import { Public } from '../auth/decorators/public.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS_CLIENT } from '../scheduler/scheduler.constants';
import { EgressIpService } from './egress-ip.service';

/**
 * Two endpoints:
 *   GET /health       — always 200 with a tiny body. Uptime checks (UptimeRobot,
 *                        BetterStack's free tier) ping this every 60-300s.
 *   GET /health/deep  — checks DB + Redis reachability. Returns 503 if anything
 *                        is down, with a body explaining what failed. Useful for
 *                        manual debugging or a second uptime check.
 *
 * We keep them separate so a degraded Redis (bullmq down) doesn't trip an
 * uptime alert if the core API is still serving reads.
 */
@Controller('health')
@SkipThrottle()
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly egress: EgressIpService,
    @Optional() @Inject(REDIS_CLIENT) private readonly redis: Redis | null = null,
  ) {}

  /** Public: the outbound IP customers add to their DB allowlist. Null if the
   *  server couldn't detect it and no EGRESS_IP override is set. */
  @Public()
  @Get('egress-ip')
  egressIp() {
    return { ip: this.egress.get() };
  }

  @Public()
  @Get()
  async liveness() {
    return { status: 'ok', ts: new Date().toISOString() };
  }

  @Public()
  @Get('deep')
  async readiness() {
    const started = Date.now();
    const checks: Record<string, { ok: boolean; ms?: number; error?: string }> = {};

    // Postgres: a 1 is enough to confirm the connection + query engine work.
    const dbStart = Date.now();
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      checks.database = { ok: true, ms: Date.now() - dbStart };
    } catch (err) {
      checks.database = { ok: false, ms: Date.now() - dbStart, error: (err as Error).message.slice(0, 200) };
    }

    // Redis is optional — only check if configured.
    if (this.redis) {
      const redisStart = Date.now();
      try {
        const pong = await this.redis.ping();
        checks.redis = { ok: pong === 'PONG', ms: Date.now() - redisStart };
      } catch (err) {
        checks.redis = { ok: false, ms: Date.now() - redisStart, error: (err as Error).message.slice(0, 200) };
      }
    }

    const allOk = Object.values(checks).every((c) => c.ok);
    const body = {
      status: allOk ? 'ok' : 'degraded',
      ts: new Date().toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
      totalMs: Date.now() - started,
      checks,
    };
    if (!allOk) throw new ServiceUnavailableException(body);
    return body;
  }
}
