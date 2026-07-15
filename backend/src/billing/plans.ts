import type { PlanConfig, PlanTier, Subscription } from '@prisma/client';

/**
 * Seed defaults for each plan tier. Written once on boot (create-if-absent, so
 * operator edits are never clobbered) and thereafter editable from the admin
 * panel. Prices are whole IQD per seat / month.
 */
export const DEFAULT_PLANS: Array<Omit<PlanConfig, 'updatedByOperatorId' | 'updatedAt' | 'createdAt'>> = [
  {
    // The 7-day trial allowance. Granted only while a TRIALING subscription is
    // active; once it lapses the workspace is LOCKED (see LOCKED_LIMITS) and
    // must subscribe. Editable in the admin panel.
    tier: 'FREE',
    name: 'Trial',
    seatPriceIqd: 0,
    maxConnections: 1,
    aiEnabled: false,
    dailyAiCalls: 0,
    maxScheduledQueries: 0,
    maxWebhooksPerConnection: 0,
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
 * Limits for a workspace with no active entitlement — nothing is free. A user
 * lands here before starting a trial, after the trial/subscription lapses, or
 * when SUSPENDED. They must subscribe to do anything.
 */
export const LOCKED_LIMITS = {
  tier: 'FREE' as PlanTier,
  name: 'No plan',
  seatPriceIqd: 0,
  maxConnections: 0,
  aiEnabled: false,
  dailyAiCalls: 0,
  maxScheduledQueries: 0,
  maxWebhooksPerConnection: 0,
  maxSeats: 1,
};

/**
 * Whether a subscription currently entitles its workspace to its plan's limits.
 * True only while the period is open and the sub isn't suspended — so both a
 * lapsed trial and a lapsed paid plan drop to LOCKED. This is the single gate
 * that makes access expire exactly at `periodEnd`, no scheduler required.
 */
export function isEntitled(
  sub: Pick<Subscription, 'status' | 'periodEnd'> | null,
  now: Date = new Date(),
): boolean {
  return !!sub && sub.status !== 'SUSPENDED' && sub.periodEnd > now;
}

/**
 * The tier whose limits currently apply. An entitled subscription yields its
 * own plan (FREE=trial, PRO, TEAM); anything else yields FREE as a label but
 * callers should use `isEntitled` + LOCKED_LIMITS for the actual caps.
 */
export function effectiveTier(
  sub: Pick<Subscription, 'plan' | 'status' | 'periodEnd'> | null,
  now: Date = new Date(),
): PlanTier {
  if (!sub || !isEntitled(sub, now)) return 'FREE';
  return sub.plan;
}
