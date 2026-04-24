import { Body, Controller, Delete, Get, NotFoundException, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { OperatorGuard, OperatorRequest, SuperOperatorGuard } from './operator.guard';
import { OperatorAuditService } from './operator-audit.service';
import { Public } from '../auth/decorators/public.decorator';

const SuspendDto = z.object({
  reason: z.string().min(1).max(500),
});
const OverrideDto = z.object({
  note: z.string().max(500).optional(),
  status: z.enum(['TRIALING', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELLED']).optional(),
  periodEnd: z.string().datetime().optional(),
  aiTopUpPacks: z.number().int().min(0).max(1000).optional(),
});

/**
 * Operator-only user management. Deliberately returns nothing that lets
 * the operator see customer data — no connection names, hosts, table names,
 * SQL text, dashboard content. Aggregate counts only.
 */
@Public()
@UseGuards(OperatorGuard)
@Controller('operator/users')
export class OperatorUsersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: OperatorAuditService,
  ) {}

  @Get()
  async list(
    @Query('q') q?: string,
    @Query('status') status?: string,
    @Query('limit') limitRaw = '50',
    @Query('offset') offsetRaw = '0',
  ) {
    const limit = Math.min(parseInt(limitRaw, 10) || 50, 200);
    const offset = Math.max(parseInt(offsetRaw, 10) || 0, 0);
    const where: Record<string, unknown> = {};
    if (q) {
      where.OR = [
        { email: { contains: q, mode: 'insensitive' } },
        { displayName: { contains: q, mode: 'insensitive' } },
      ];
    }
    if (status === 'suspended') where.suspendedAt = { not: null };
    if (status === 'active') where.suspendedAt = null;

    const [rows, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
        select: {
          id: true,
          email: true,
          displayName: true,
          isAdmin: true,
          suspendedAt: true,
          suspendedReason: true,
          emailVerifiedAt: true,
          createdAt: true,
          _count: {
            select: {
              connections: true,
              ownedWorkspaces: true,
              workspaceMembers: true,
            },
          },
        },
      }),
      this.prisma.user.count({ where }),
    ]);
    return {
      rows: rows.map((u) => ({
        id: u.id,
        email: u.email,
        displayName: u.displayName,
        isAdmin: u.isAdmin,
        suspendedAt: u.suspendedAt,
        suspendedReason: u.suspendedReason,
        emailVerified: !!u.emailVerifiedAt,
        createdAt: u.createdAt,
        connections: u._count.connections,
        workspacesOwned: u._count.ownedWorkspaces,
        workspacesJoined: u._count.workspaceMembers,
      })),
      total,
    };
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    const u = await this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        displayName: true,
        isAdmin: true,
        suspendedAt: true,
        suspendedReason: true,
        emailVerifiedAt: true,
        createdAt: true,
        ownedWorkspaces: {
          select: {
            id: true,
            name: true,
            slug: true,
            _count: { select: { members: true } },
            subscription: {
              select: { status: true, periodStart: true, periodEnd: true, aiTopUpPacks: true },
            },
          },
        },
      },
    });
    if (!u) throw new NotFoundException();
    // Compute AI usage for today so the operator can see how close a user is
    // to their daily limit.
    const today = new Date().toISOString().slice(0, 10);
    const usage = await this.prisma.aiUsageDay.findUnique({
      where: { userId_day: { userId: id, day: today } },
      select: { callsUsed: true },
    });
    return {
      user: {
        id: u.id,
        email: u.email,
        displayName: u.displayName,
        isAdmin: u.isAdmin,
        suspendedAt: u.suspendedAt,
        suspendedReason: u.suspendedReason,
        emailVerified: !!u.emailVerifiedAt,
        createdAt: u.createdAt,
      },
      workspaces: u.ownedWorkspaces.map((w) => ({
        id: w.id,
        name: w.name,
        slug: w.slug,
        seats: w._count.members,
        subscription: w.subscription,
      })),
      aiUsageToday: usage?.callsUsed ?? 0,
    };
  }

  @Post(':id/suspend')
  @UseGuards(SuperOperatorGuard)
  async suspend(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: OperatorRequest,
  ) {
    const dto = SuspendDto.parse(body);
    const user = await this.prisma.user.findUnique({ where: { id }, select: { email: true } });
    if (!user) throw new NotFoundException();
    await this.prisma.user.update({
      where: { id },
      data: { suspendedAt: new Date(), suspendedReason: dto.reason },
    });
    // Revoke all active refresh tokens so the user is kicked out of any
    // open sessions immediately — otherwise their access JWT would still
    // work until it expires.
    await this.prisma.refreshToken.updateMany({
      where: { userId: id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await this.audit.log({
      operatorId: req.operator!.id,
      action: 'USER_SUSPENDED',
      targetType: 'User',
      targetId: id,
      reason: dto.reason,
      metadata: { email: user.email },
    });
    return { ok: true as const };
  }

  @Post(':id/unsuspend')
  @UseGuards(SuperOperatorGuard)
  async unsuspend(@Param('id') id: string, @Req() req: OperatorRequest) {
    const user = await this.prisma.user.findUnique({ where: { id }, select: { email: true, suspendedAt: true } });
    if (!user) throw new NotFoundException();
    if (!user.suspendedAt) return { ok: true as const };
    await this.prisma.user.update({
      where: { id },
      data: { suspendedAt: null, suspendedReason: null },
    });
    await this.audit.log({
      operatorId: req.operator!.id,
      action: 'USER_UNSUSPENDED',
      targetType: 'User',
      targetId: id,
      metadata: { email: user.email },
    });
    return { ok: true as const };
  }

  @Delete(':id')
  @UseGuards(SuperOperatorGuard)
  async remove(@Param('id') id: string, @Req() req: OperatorRequest) {
    const user = await this.prisma.user.findUnique({ where: { id }, select: { email: true } });
    if (!user) throw new NotFoundException();
    // Cascade will clean refresh tokens, workspace memberships, AI usage, etc.
    // Customer-owned connections go with them (their data is encrypted with
    // per-connection DEKs — nothing for the operator to see or leak).
    await this.prisma.user.delete({ where: { id } });
    await this.audit.log({
      operatorId: req.operator!.id,
      action: 'USER_DELETED',
      targetType: 'User',
      targetId: id,
      reason: 'GDPR / account deletion',
      metadata: { email: user.email },
    });
    return { ok: true as const };
  }

  @Patch('subscriptions/:workspaceId')
  @UseGuards(SuperOperatorGuard)
  async overrideSubscription(
    @Param('workspaceId') workspaceId: string,
    @Body() body: unknown,
    @Req() req: OperatorRequest,
  ) {
    const dto = OverrideDto.parse(body);
    // Upsert so operators can manually activate a workspace that never had
    // one (e.g. migrating legacy installs).
    const existing = await this.prisma.subscription.findUnique({ where: { workspaceId } });
    const patch: Record<string, unknown> = {};
    if (dto.status) patch.status = dto.status;
    if (dto.periodEnd) patch.periodEnd = new Date(dto.periodEnd);
    if (dto.aiTopUpPacks !== undefined) patch.aiTopUpPacks = dto.aiTopUpPacks;
    if (dto.note !== undefined) patch.manualOverrideNote = dto.note;

    if (existing) {
      await this.prisma.subscription.update({ where: { workspaceId }, data: patch });
    } else {
      // Sensible defaults for a brand-new manual sub: 30-day window, trialing.
      await this.prisma.subscription.create({
        data: {
          workspaceId,
          status: dto.status ?? 'TRIALING',
          periodStart: new Date(),
          periodEnd: dto.periodEnd ? new Date(dto.periodEnd) : new Date(Date.now() + 30 * 864e5),
          aiTopUpPacks: dto.aiTopUpPacks ?? 0,
          manualOverrideNote: dto.note,
        },
      });
    }
    await this.audit.log({
      operatorId: req.operator!.id,
      action: 'SUBSCRIPTION_OVERRIDE',
      targetType: 'Workspace',
      targetId: workspaceId,
      reason: dto.note,
      metadata: dto as Record<string, unknown>,
    });
    return { ok: true as const };
  }
}
