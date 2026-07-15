import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Days a lapsed paid sub sits in PAST_DUE before it's marked SUSPENDED. */
const GRACE_DAYS = 7;

/**
 * Advances subscription *status labels* as periods lapse, for display and
 * reporting. Note this is NOT what enforces access — entitlement already
 * follows `periodEnd` directly (see plans.ts `effectiveTier`), so a workspace
 * loses paid limits the moment its period ends whether or not this sweep has
 * run. The sweep is idempotent (guarded WHERE clauses) and safe to run from a
 * single API instance on a timer.
 */
@Injectable()
export class BillingLifecycleService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BillingLifecycleService.name);
  private timer?: ReturnType<typeof setInterval>;
  private kickoff?: ReturnType<typeof setTimeout>;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    // First pass a minute after boot (let the DB/migrations settle), then daily.
    this.kickoff = setTimeout(() => void this.sweep(), 60_000);
    this.timer = setInterval(() => void this.sweep(), DAY_MS);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    if (this.kickoff) clearTimeout(this.kickoff);
  }

  async sweep(now: Date = new Date()): Promise<{ pastDue: number; suspended: number }> {
    try {
      // Paid subs whose period has elapsed → PAST_DUE (renew prompt in the UI).
      const pastDue = await this.prisma.subscription.updateMany({
        where: {
          status: { in: ['ACTIVE', 'TRIALING'] },
          plan: { not: 'FREE' },
          periodEnd: { lt: now },
        },
        data: { status: 'PAST_DUE' },
      });
      // PAST_DUE beyond the grace window → SUSPENDED.
      const graceCutoff = new Date(now.getTime() - GRACE_DAYS * DAY_MS);
      const suspended = await this.prisma.subscription.updateMany({
        where: { status: 'PAST_DUE', periodEnd: { lt: graceCutoff } },
        data: { status: 'SUSPENDED' },
      });
      if (pastDue.count || suspended.count) {
        this.logger.log(
          `Billing sweep: ${pastDue.count} → PAST_DUE, ${suspended.count} → SUSPENDED.`,
        );
      }
      return { pastDue: pastDue.count, suspended: suspended.count };
    } catch (e) {
      this.logger.warn(`Billing sweep failed: ${(e as Error).message}`);
      return { pastDue: 0, suspended: 0 };
    }
  }
}
