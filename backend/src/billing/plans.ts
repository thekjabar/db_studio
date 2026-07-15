import type { PlanConfig, PlanTier, Subscription } from '@prisma/client';

/**
 * Seed defaults for each plan tier. Written once on boot (create-if-absent, so
 * operator edits are never clobbered) and thereafter editable from the admin
 * panel. Prices are whole IQD per seat / month.
 */
export const DEFAULT_PLANS: Array<Omit<PlanConfig, 'updatedByOperatorId' | 'updatedAt' | 'createdAt'>> = [
  {
    tier: 'FREE',
    name: 'Free',
    seatPriceIqd: 0,
    maxConnections: 3,
    aiEnabled: false,
    dailyAiCalls: 0,
    maxScheduledQueries: 2,
    maxWebhooksPerConnection: 1,
    maxSeats: 1,
  },
  {
    tier: 'PRO',
    name: 'Pro',
    seatPriceIqd: 15000,
    maxConnections: 25,
    aiEnabled: true,
    dailyAiCalls: 50,
    maxScheduledQueries: 25,
    maxWebhooksPerConnection: 10,
    maxSeats: 5,
  },
  {
    tier: 'TEAM',
    name: 'Team',
    seatPriceIqd: 25000,
    maxConnections: 100,
    aiEnabled: true,
    dailyAiCalls: 200,
    maxScheduledQueries: 100,
    maxWebhooksPerConnection: 25,
    maxSeats: null,
  },
];

/**
 * The tier whose limits currently apply to a workspace, given its subscription
 * row (or null). Entitlement follows `periodEnd` directly — so paid access
 * expires exactly when the paid period ends, even if the lifecycle scheduler
 * never runs. Free is the floor: a missing sub, a FREE plan, a SUSPENDED sub,
 * or any sub whose period has elapsed all resolve to FREE. ACTIVE / TRIALING /
 * PAST_DUE / CANCELLED all keep their tier until periodEnd passes.
 */
export function effectiveTier(
  sub: Pick<Subscription, 'plan' | 'status' | 'periodEnd'> | null,
  now: Date = new Date(),
): PlanTier {
  if (!sub || sub.plan === 'FREE') return 'FREE';
  if (sub.status === 'SUSPENDED') return 'FREE';
  if (sub.periodEnd <= now) return 'FREE';
  return sub.plan;
}
