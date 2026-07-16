import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { PaymentAttempt, PlanTier, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../config/config.service';
import { WaylClient, type WaylWebhookPayload } from './wayl.client';
import { PlanService } from './plan.service';
import { effectiveTier } from './plans';

/** Wayl statuses that mean the money arrived / definitively didn't. */
const PAID_STATUSES = ['Complete', 'Delivered'];
const FAILED_STATUSES = ['Cancelled', 'Rejected', 'Returned'];

const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cfg: AppConfigService,
    private readonly wayl: WaylClient,
    private readonly plans: PlanService,
  ) {}

  /** Everything the (dynamic per-seat) billing page needs in one call. */
  async overview(userId: string, workspaceId?: string) {
    const ws = await this.resolveWorkspace(userId, workspaceId);
    const { tier, subscription, locked } = await this.plans.forWorkspace(ws.id);
    const paid = await this.plans.config('PRO'); // the single dynamic paid plan
    const free = await this.plans.config('FREE');

    // Whole days left in an active trial (0 when not trialing / lapsed).
    const now = Date.now();
    const trialDaysLeft =
      subscription?.status === 'TRIALING' && subscription.periodEnd.getTime() > now
        ? Math.ceil((subscription.periodEnd.getTime() - now) / (24 * 60 * 60 * 1000))
        : 0;

    // Seats they currently hold (only meaningful while entitled + paid).
    const entitledPaid = !locked && (tier === 'PRO' || tier === 'TEAM');
    const currentSeats = entitledPaid ? subscription?.seats ?? 0 : 0;
    const unlimited = entitledPaid && tier === 'TEAM';
    const minSeats = await this.minSeatsForOwner(ws.ownerId);

    const limits = (p: typeof paid) => ({
      maxConnections: p.maxConnections,
      aiEnabled: p.aiEnabled,
      dailyAiCalls: p.dailyAiCalls,
      maxScheduledQueries: p.maxScheduledQueries,
      maxWebhooksPerConnection: p.maxWebhooksPerConnection,
    });

    return {
      waylEnabled: this.cfg.waylEnabled,
      currency: 'IQD' as const,
      workspace: { id: ws.id, name: ws.name, isPersonal: ws.isPersonal },
      isOwner: ws.ownerId === userId,
      effectiveTier: tier,
      /** True when there's no active entitlement — the user must subscribe. */
      locked,
      /** Days remaining in the trial (0 if not on an active trial). */
      trialDaysLeft,
      /** Dynamic per-seat pricing. */
      perSeatPriceIqd: paid.seatPriceIqd,
      /** Seats the workspace currently holds (0 if not on a paid plan). */
      currentSeats,
      /** Owner is on the grandfathered unlimited (Team) plan. */
      unlimited,
      /** Fewest seats they may buy (largest member+invite count on a connection). */
      minSeats,
      /** Feature limits by tier for the comparison UI. */
      freePlan: { name: free.name, maxSeats: free.maxSeats ?? 1, ...limits(free) },
      paidPlan: { name: paid.name, ...limits(paid) },
      subscription: subscription
        ? {
            plan: subscription.plan,
            seats: subscription.seats,
            status: subscription.status,
            periodStart: subscription.periodStart,
            periodEnd: subscription.periodEnd,
          }
        : null,
      recentPayments: await this.prisma.paymentAttempt.findMany({
        where: { workspaceId: ws.id },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: {
          id: true,
          plan: true,
          seats: true,
          amountIqd: true,
          status: true,
          createdAt: true,
          paidAt: true,
        },
      }),
    };
  }

  /**
   * Start a Wayl hosted checkout for `seats` seats on the paid plan. Dynamic
   * per-seat billing: the customer picks a team size and pays seatPrice × seats
   * for a monthly period. Only the workspace owner may pay. The seat count and
   * amount are snapshotted onto the PaymentAttempt so a later price change can't
   * rewrite history.
   */
  async checkout(userId: string, seats: number, workspaceId?: string) {
    if (!this.cfg.waylEnabled) {
      throw new ServiceUnavailableException(
        "Online payment isn't configured yet. Please try again later.",
      );
    }
    const ws = await this.resolveWorkspace(userId, workspaceId);
    if (ws.ownerId !== userId) {
      throw new ForbiddenException('Only the workspace owner can manage billing.');
    }

    const plan: PlanTier = 'PRO'; // the single dynamic paid plan
    const config = await this.plans.config(plan);

    // Clamp/validate the requested seat count: at least what the owner already
    // uses (so a downgrade can't strand an over-limit connection), min 1.
    const seatsInt = Math.floor(Number(seats));
    if (!Number.isFinite(seatsInt) || seatsInt < 1) {
      throw new BadRequestException('Choose at least 1 seat.');
    }
    if (seatsInt > 1000) {
      throw new BadRequestException('That is more seats than we can process at once — contact us.');
    }
    const minSeats = await this.minSeatsForOwner(userId);
    if (seatsInt < minSeats) {
      throw new BadRequestException(
        `You already use ${minSeats} seat(s) on your connections; choose at least ${minSeats}.`,
      );
    }

    const amountIqd = config.seatPriceIqd * seatsInt;
    if (amountIqd <= 0) {
      throw new BadRequestException('Per-seat price is not set. Contact support.');
    }

    const referenceId = `QS-${ws.id.slice(0, 8)}-${randomBytes(4).toString('hex')}`;

    // Record the attempt first so there's always an audit row, even if the
    // Wayl call or a later step fails.
    const attempt = await this.prisma.paymentAttempt.create({
      data: {
        workspaceId: ws.id,
        userId,
        referenceId,
        plan,
        seats: seatsInt,
        amountIqd,
        months: 1,
        status: 'PENDING',
      },
    });

    try {
      const link = await this.wayl.createLink({
        referenceId,
        totalIqd: amountIqd,
        customParameter: `sub:${ws.id}:${plan}`,
        lineItems: [
          {
            label: `Query Schema — ${seatsInt} seat(s) × ${config.seatPriceIqd} IQD/mo`,
            amountIqd,
            type: 'increase',
          },
        ],
      });
      await this.prisma.paymentAttempt.update({
        where: { id: attempt.id },
        data: { providerRef: link.id, rawResponse: link as unknown as Prisma.InputJsonValue },
      });
      return { url: link.url, referenceId, amountIqd, seats: seatsInt, plan };
    } catch (e) {
      await this.prisma.paymentAttempt.update({
        where: { id: attempt.id },
        data: { status: 'FAILED', failureReason: (e as Error).message.slice(0, 300) },
      });
      this.logger.error(`Wayl checkout failed for ${referenceId}: ${(e as Error).message}`);
      throw new ServiceUnavailableException(
        'Could not start the payment. Please try again in a moment.',
      );
    }
  }

  /**
   * Primary trust path. Verifies the HMAC signature over the RAW body, then
   * routes to the matching PaymentAttempt by providerRef and reconciles.
   */
  async handleWebhook(rawBody: Buffer, signature: string | undefined) {
    if (!this.wayl.verifySignature(rawBody, signature)) {
      // Log (without the body) so we can tell "Wayl never called" apart from
      // "Wayl called but the signature didn't match" when debugging payments.
      this.logger.warn(
        `Wayl webhook rejected: ${signature ? 'signature mismatch' : 'missing signature'} (${rawBody.length} bytes)`,
      );
      throw new UnauthorizedException('Invalid signature');
    }
    let payload: WaylWebhookPayload;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new BadRequestException('Invalid JSON body');
    }
    if (!payload?.id && !payload?.referenceId) {
      throw new BadRequestException('Missing payment reference');
    }

    const attempt = await this.prisma.paymentAttempt.findFirst({
      where: payload.id
        ? { providerRef: payload.id, provider: 'wayl' }
        : { referenceId: payload.referenceId, provider: 'wayl' },
    });
    if (!attempt) {
      this.logger.warn(`Wayl webhook for unknown ref ${payload.id ?? payload.referenceId}; ignoring.`);
      return { received: true };
    }
    await this.reconcile(attempt, payload.paymentStatus, payload.total, payload);
    return { received: true };
  }

  /**
   * Fallback trust path used when the customer returns from Wayl. Re-fetches
   * the link straight from Wayl (the client can't lie) and reconciles.
   */
  async verifyReturn(userId: string, referenceId: string) {
    const attempt = await this.prisma.paymentAttempt.findUnique({ where: { referenceId } });
    if (!attempt) throw new NotFoundException('Payment not found');
    const ws = await this.prisma.workspace.findUnique({ where: { id: attempt.workspaceId } });
    if (!ws || ws.ownerId !== userId) {
      throw new ForbiddenException('Not your payment.');
    }

    if (attempt.status === 'PENDING' && this.cfg.waylEnabled) {
      try {
        // Wayl's GET /links/{ref} resolves ONLY by our merchant referenceId,
        // not by the internal link id — passing providerRef 404s.
        const link = await this.wayl.getLink(referenceId);
        await this.reconcile(attempt, link.status, Number(link.total), link);
      } catch (e) {
        this.logger.warn(`verifyReturn getLink failed for ${referenceId}: ${(e as Error).message}`);
      }
    }
    const fresh = await this.prisma.paymentAttempt.findUnique({
      where: { referenceId },
      select: { status: true, plan: true, failureReason: true },
    });
    const overview = await this.overview(userId, attempt.workspaceId);
    return { payment: fresh, ...overview };
  }

  /**
   * Idempotent reconcile shared by webhook + verify. Runs in a transaction:
   * marks the attempt paid/failed and, on payment, extends the workspace
   * subscription by one monthly period on the target tier.
   */
  private async reconcile(
    attempt: PaymentAttempt,
    waylStatus: string | undefined,
    totalIqd: number | undefined,
    raw: unknown,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const fresh = await tx.paymentAttempt.findUnique({ where: { id: attempt.id } });
      if (!fresh) return;

      // Already terminal — just refresh the stored payload and stop.
      if (fresh.status !== 'PENDING') {
        await tx.paymentAttempt.update({
          where: { id: fresh.id },
          data: { rawResponse: raw as Prisma.InputJsonValue },
        });
        return;
      }

      const status = waylStatus ?? '';
      if (PAID_STATUSES.includes(status)) {
        // Amount guard: never grant access if the charged total doesn't match.
        if (totalIqd != null && Number(totalIqd) !== fresh.amountIqd) {
          this.logger.error(
            `Amount mismatch on ${fresh.referenceId}: charged ${totalIqd} vs expected ${fresh.amountIqd}; not granting.`,
          );
          return;
        }
        const now = new Date();
        await tx.paymentAttempt.update({
          where: { id: fresh.id },
          data: { status: 'PAID', paidAt: now, rawResponse: raw as Prisma.InputJsonValue },
        });

        const existing = await tx.subscription.findUnique({
          where: { workspaceId: fresh.workspaceId },
        });
        const base =
          existing && existing.periodEnd > now ? existing.periodEnd : now;
        const periodEnd = new Date(base.getTime() + fresh.months * 30 * DAY_MS);

        await tx.subscription.upsert({
          where: { workspaceId: fresh.workspaceId },
          create: {
            workspaceId: fresh.workspaceId,
            plan: fresh.plan,
            seats: fresh.seats,
            status: 'ACTIVE',
            periodStart: now,
            periodEnd,
          },
          update: { plan: fresh.plan, seats: fresh.seats, status: 'ACTIVE', periodEnd },
        });
        this.logger.log(
          `Payment ${fresh.referenceId} settled → workspace ${fresh.workspaceId} on ${fresh.plan} × ${fresh.seats} seat(s) until ${periodEnd.toISOString()}`,
        );
      } else if (FAILED_STATUSES.includes(status)) {
        await tx.paymentAttempt.update({
          where: { id: fresh.id },
          data: {
            status: 'FAILED',
            failureReason: status,
            rawResponse: raw as Prisma.InputJsonValue,
          },
        });
      } else {
        // Non-terminal (Created/Pending/Processing): store payload, stay PENDING.
        await tx.paymentAttempt.update({
          where: { id: fresh.id },
          data: { rawResponse: raw as Prisma.InputJsonValue },
        });
      }
    });
  }

  /** Owner-scoped workspace resolution. Defaults to the user's personal
   *  workspace when none is specified. */
  private async resolveWorkspace(userId: string, workspaceId?: string) {
    if (workspaceId) {
      const ws = await this.prisma.workspace.findUnique({ where: { id: workspaceId } });
      if (!ws) throw new NotFoundException('Workspace not found');
      // Must be a member or the owner to view; ownership is checked separately
      // for mutations.
      const member =
        ws.ownerId === userId ||
        (await this.prisma.workspaceMember.findFirst({
          where: { workspaceId: ws.id, userId },
          select: { id: true },
        }));
      if (!member) throw new ForbiddenException('Not a member of this workspace.');
      return ws;
    }
    const personal = await this.prisma.workspace.findFirst({
      where: { ownerId: userId, isPersonal: true },
    });
    if (personal) return personal;
    const owned = await this.prisma.workspace.findFirst({
      where: { ownerId: userId },
      orderBy: { createdAt: 'asc' },
    });
    if (!owned) throw new NotFoundException('No workspace found for this user.');
    return owned;
  }

  private async seatCount(workspaceId: string): Promise<number> {
    const members = await this.prisma.workspaceMember.count({ where: { workspaceId } });
    return Math.max(members, 1);
  }

  /**
   * The fewest seats the owner can buy: the largest member+invite count across
   * any connection they own (a connection can hold up to `seats` members, so
   * you can't buy fewer seats than a connection already uses). Minimum 1.
   */
  private async minSeatsForOwner(userId: string): Promise<number> {
    const conns = await this.prisma.connection.findMany({
      where: { ownerId: userId },
      select: {
        _count: { select: { members: true, invites: true } },
      },
    });
    let max = 1;
    for (const c of conns) {
      max = Math.max(max, c._count.members + c._count.invites);
    }
    return max;
  }

  /** Effective tier for a workspace (used by gating services). */
  async effectiveTierForWorkspace(workspaceId: string): Promise<PlanTier> {
    const sub = await this.prisma.subscription.findUnique({
      where: { workspaceId },
      select: { plan: true, status: true, periodEnd: true },
    });
    return effectiveTier(sub);
  }
}
