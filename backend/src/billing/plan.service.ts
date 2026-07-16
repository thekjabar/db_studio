import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { PlanConfig, PlanTier, Subscription } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { DEFAULT_PLANS, LOCKED_LIMITS, isEntitled } from './plans';

const TIER_ORDER: PlanTier[] = ['FREE', 'PRO', 'TEAM'];

/**
 * Single source of truth for "what plan is this workspace/user on and what may
 * they do". Reads the operator-editable PlanConfig rows and resolves the
 * effective tier from a workspace's subscription. Seeds tier defaults on boot
 * (create-if-absent, so operator edits are never overwritten).
 */
@Injectable()
export class PlanService implements OnModuleInit {
  private readonly logger = new Logger(PlanService.name);

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    try {
      const res = await this.prisma.planConfig.createMany({
        data: DEFAULT_PLANS,
        skipDuplicates: true,
      });
      if (res.count > 0) this.logger.log(`Seeded ${res.count} default plan(s).`);
    } catch (e) {
      // Non-fatal: the table may not exist yet during a migration window.
      this.logger.warn(`Could not seed plan defaults: ${(e as Error).message}`);
    }
  }

  /** All tiers in display order, falling back to the coded default for any
   *  row that somehow doesn't exist yet. */
  async all(): Promise<PlanConfig[]> {
    const rows = await this.prisma.planConfig.findMany();
    const byTier = new Map(rows.map((r) => [r.tier, r]));
    return TIER_ORDER.map(
      (t) => byTier.get(t) ?? (this.defaultRow(t) as PlanConfig),
    );
  }

  /** The config for one tier (DB row, else coded default). */
  async config(tier: PlanTier): Promise<PlanConfig> {
    const row = await this.prisma.planConfig.findUnique({ where: { tier } });
    return row ?? (this.defaultRow(tier) as PlanConfig);
  }

  /** Effective tier + its limits + the raw subscription for a workspace. When
   *  there's no active entitlement the limits are LOCKED (all zero) — the
   *  workspace must subscribe. */
  async forWorkspace(workspaceId: string): Promise<{
    tier: PlanTier;
    config: PlanConfig;
    subscription: Subscription | null;
    locked: boolean;
  }> {
    const subscription = await this.prisma.subscription.findUnique({
      where: { workspaceId },
    });
    if (!isEntitled(subscription)) {
      return { tier: 'FREE', config: this.lockedConfig(), subscription, locked: true };
    }
    const config = await this.config(subscription!.plan);
    return { tier: subscription!.plan, config, subscription, locked: false };
  }

  private lockedConfig(): PlanConfig {
    return { ...LOCKED_LIMITS, updatedByOperatorId: null, updatedAt: new Date(), createdAt: new Date() } as PlanConfig;
  }

  /**
   * The strongest plan a user is entitled to across every workspace they
   * belong to — used for per-user gating (AI). "Strongest" = AI-enabled with
   * the highest daily AI allowance; ties break by tier order.
   */
  async forUser(userId: string): Promise<PlanConfig> {
    const subs = await this.prisma.subscription.findMany({
      where: { workspace: { members: { some: { userId } } } },
      select: { plan: true, status: true, periodEnd: true },
    });
    // Also consider workspaces they OWN (owner may not be a member row).
    const owned = await this.prisma.subscription.findMany({
      where: { workspace: { ownerId: userId } },
      select: { plan: true, status: true, periodEnd: true },
    });
    const now = new Date();
    // Only ENTITLED subscriptions count — a lapsed trial/plan grants nothing.
    const tiers = [...subs, ...owned]
      .filter((s) => isEntitled(s, now))
      .map((s) => s.plan);
    if (tiers.length === 0) return this.lockedConfig();
    const configs = await Promise.all([...new Set(tiers)].map((t) => this.config(t)));
    return configs.reduce((best, c) => {
      const better =
        Number(c.aiEnabled) - Number(best.aiEnabled) ||
        c.dailyAiCalls - best.dailyAiCalls ||
        TIER_ORDER.indexOf(c.tier) - TIER_ORDER.indexOf(best.tier);
      return better > 0 ? c : best;
    });
  }

  /**
   * How many members the owner may put on a connection — the effective seat
   * cap under dynamic per-seat billing:
   *   PRO  → the seats they paid for (Subscription.seats)
   *   TEAM → unlimited (null) — grandfathered manual overrides
   *   else → 1 (trial / locked)
   * Considers every workspace the user owns; takes the most generous.
   */
  async seatLimitForUser(userId: string): Promise<number | null> {
    const owned = await this.prisma.subscription.findMany({
      where: { workspace: { ownerId: userId } },
      select: { plan: true, status: true, periodEnd: true, seats: true },
    });
    const now = new Date();
    const entitled = owned.filter((s) => isEntitled(s, now));
    if (entitled.length === 0) return 1;
    if (entitled.some((s) => s.plan === 'TEAM')) return null; // unlimited
    const proSeats = entitled.filter((s) => s.plan === 'PRO').map((s) => s.seats);
    if (proSeats.length) return Math.max(1, ...proSeats);
    return 1;
  }

  /** Seat cap for a specific workspace (its own subscription). */
  async seatLimitForWorkspace(workspaceId: string): Promise<number | null> {
    const { tier, subscription } = await this.forWorkspace(workspaceId);
    if (tier === 'TEAM') return null;
    if (tier === 'PRO') return Math.max(1, subscription?.seats ?? 1);
    return 1;
  }

  private defaultRow(tier: PlanTier) {
    const d = DEFAULT_PLANS.find((p) => p.tier === tier)!;
    return { ...d, updatedByOperatorId: null, updatedAt: new Date(), createdAt: new Date() };
  }
}
