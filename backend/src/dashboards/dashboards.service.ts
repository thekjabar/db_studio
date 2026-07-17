import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { Role, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RbacService } from '../rbac/rbac.service';

export interface CreateDashboardInput {
  connectionId: string;
  name: string;
  description?: string;
  refreshSec?: number | null;
}

export interface UpdateDashboardInput {
  name?: string;
  description?: string | null;
  refreshSec?: number | null;
}

export interface CreateTileInput {
  savedQueryId: string;
  title?: string;
  chartOverride?: unknown;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}

export interface UpdateTileInput {
  title?: string | null;
  chartOverride?: unknown;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}

export interface ReorderTilesInput {
  tiles: { id: string; x: number; y: number; w: number; h: number }[];
}

@Injectable()
export class DashboardsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
  ) {}

  async list(userId: string, connectionId?: string) {
    // Scoped to dashboards the user can access: either they own it, or they
    // have at least VIEWER on its connection. Doing the role join with a
    // subquery avoids hydrating connections we can't show.
    const where: Prisma.DashboardWhereInput = connectionId
      ? { connectionId }
      : {
          OR: [
            { ownerId: userId },
            { connection: { ownerId: userId } },
            { connection: { members: { some: { userId } } } },
            { connection: { workspace: { members: { some: { userId } } } } },
          ],
        };
    return this.prisma.dashboard.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        name: true,
        description: true,
        connectionId: true,
        refreshSec: true,
        shareToken: true,
        updatedAt: true,
        _count: { select: { tiles: true } },
        owner: { select: { id: true, email: true, displayName: true } },
      },
    });
  }

  async getOr403(userId: string, id: string) {
    const d = await this.prisma.dashboard.findUnique({
      where: { id },
      include: {
        tiles: {
          orderBy: { y: 'asc' },
          include: {
            savedQuery: {
              select: { id: true, name: true, sqlText: true, chartConfig: true },
            },
          },
        },
      },
    });
    if (!d) throw new NotFoundException('Dashboard not found');
    // Ownership OR connection VIEWER role.
    if (d.ownerId !== userId) {
      await this.rbac.require(userId, d.connectionId, Role.VIEWER);
    }
    return d;
  }

  async getByShareToken(token: string) {
    const d = await this.prisma.dashboard.findUnique({
      where: { shareToken: token },
      include: {
        tiles: {
          orderBy: { y: 'asc' },
          include: {
            savedQuery: {
              select: {
                id: true,
                name: true,
                sqlText: true,
                chartConfig: true,
                connectionId: true,
              },
            },
          },
        },
      },
    });
    if (!d) throw new NotFoundException('Dashboard not found');
    return d;
  }

  async create(userId: string, input: CreateDashboardInput) {
    if (!input.name.trim()) throw new BadRequestException('Name required');
    // EDITOR role to create — viewers can see but not create dashboards
    // against a connection.
    await this.rbac.require(userId, input.connectionId, Role.EDITOR);
    return this.prisma.dashboard.create({
      data: {
        name: input.name.trim().slice(0, 120),
        description: input.description?.trim().slice(0, 500) || null,
        connectionId: input.connectionId,
        ownerId: userId,
        refreshSec: sanitizeRefresh(input.refreshSec ?? null),
      },
    });
  }

  async update(userId: string, id: string, patch: UpdateDashboardInput) {
    const d = await this.assertManage(userId, id);
    const data: Prisma.DashboardUpdateInput = {};
    if (patch.name !== undefined) data.name = patch.name.trim().slice(0, 120);
    if (patch.description !== undefined) {
      data.description = patch.description ? patch.description.trim().slice(0, 500) : null;
    }
    if (patch.refreshSec !== undefined) {
      data.refreshSec = sanitizeRefresh(patch.refreshSec);
    }
    await this.prisma.dashboard.update({ where: { id: d.id }, data });
    return this.getOr403(userId, id);
  }

  async remove(userId: string, id: string) {
    await this.assertManage(userId, id);
    await this.prisma.dashboard.delete({ where: { id } });
    return { ok: true as const };
  }

  async rotateShareToken(userId: string, id: string, share: boolean) {
    await this.assertManage(userId, id);
    const token = share ? randomBytes(24).toString('base64url') : null;
    await this.prisma.dashboard.update({ where: { id }, data: { shareToken: token } });
    return { shareToken: token };
  }

  async addTile(userId: string, id: string, input: CreateTileInput) {
    const d = await this.assertManage(userId, id);
    // Saved query must belong to the same connection (reject cross-connection
    // tiles — they'd break share links and confuse RBAC).
    const sq = await this.prisma.savedQuery.findUnique({
      where: { id: input.savedQueryId },
      select: { connectionId: true },
    });
    if (!sq) throw new BadRequestException('Saved query not found');
    if (sq.connectionId !== d.connectionId) {
      throw new BadRequestException('Saved query must belong to this dashboard\'s connection');
    }
    // Auto-layout: append below the current max y.
    const max = await this.prisma.dashboardTile.aggregate({
      where: { dashboardId: id },
      _max: { y: true, h: true },
    });
    const defaultY = (max._max.y ?? 0) + (max._max.h ?? 0);
    return this.prisma.dashboardTile.create({
      data: {
        dashboardId: id,
        savedQueryId: input.savedQueryId,
        title: input.title?.slice(0, 120) ?? null,
        chartOverride: (input.chartOverride ?? undefined) as Prisma.InputJsonValue | undefined,
        x: clampInt(input.x ?? 0, 0, 12),
        y: clampInt(input.y ?? defaultY, 0, 10_000),
        w: clampInt(input.w ?? 6, 1, 12),
        h: clampInt(input.h ?? 4, 1, 20),
      },
    });
  }

  async updateTile(userId: string, id: string, tileId: string, patch: UpdateTileInput) {
    await this.assertManage(userId, id);
    const data: Prisma.DashboardTileUpdateInput = {};
    if (patch.title !== undefined) data.title = patch.title ? patch.title.slice(0, 120) : null;
    if (patch.chartOverride !== undefined) {
      data.chartOverride = (patch.chartOverride ?? Prisma.DbNull) as Prisma.InputJsonValue;
    }
    if (patch.x !== undefined) data.x = clampInt(patch.x, 0, 12);
    if (patch.y !== undefined) data.y = clampInt(patch.y, 0, 10_000);
    if (patch.w !== undefined) data.w = clampInt(patch.w, 1, 12);
    if (patch.h !== undefined) data.h = clampInt(patch.h, 1, 20);
    // SECURITY: scope the tile to the dashboard we authorized — updateMany with
    // both ids means a tileId from someone else's dashboard simply matches
    // nothing, instead of being written to.
    const res = await this.prisma.dashboardTile.updateMany({
      where: { id: tileId, dashboardId: id },
      data,
    });
    if (res.count === 0) throw new NotFoundException('Tile not found');
    return this.prisma.dashboardTile.findUnique({ where: { id: tileId } });
  }

  async removeTile(userId: string, id: string, tileId: string) {
    await this.assertManage(userId, id);
    // SECURITY: as above — without dashboardId this deleted any tile by id,
    // including another tenant's.
    const res = await this.prisma.dashboardTile.deleteMany({ where: { id: tileId, dashboardId: id } });
    if (res.count === 0) throw new NotFoundException('Tile not found');
    return { ok: true as const };
  }

  async reorderTiles(userId: string, id: string, input: ReorderTilesInput) {
    await this.assertManage(userId, id);
    // One transaction — either all tile positions update or none, preventing
    // "half drag" corruption if a later update fails.
    // SECURITY: updateMany + dashboardId so a foreign tile id in the payload
    // can't be repositioned (it matches nothing rather than writing).
    await this.prisma.$transaction(
      input.tiles.map((t) =>
        this.prisma.dashboardTile.updateMany({
          where: { id: t.id, dashboardId: id },
          data: {
            x: clampInt(t.x, 0, 12),
            y: clampInt(t.y, 0, 10_000),
            w: clampInt(t.w, 1, 12),
            h: clampInt(t.h, 1, 20),
          },
        }),
      ),
    );
    return { ok: true as const };
  }

  private async assertManage(userId: string, id: string) {
    const d = await this.prisma.dashboard.findUnique({
      where: { id },
      select: { id: true, ownerId: true, connectionId: true },
    });
    if (!d) throw new NotFoundException('Dashboard not found');
    if (d.ownerId === userId) return d;
    // Connection OWNER can also manage team dashboards — mirrors the
    // scheduled-queries permissioning so the rules feel consistent.
    const role = await this.rbac.effectiveRole(userId, d.connectionId);
    if (role !== Role.OWNER) {
      throw new ForbiddenException('Only the dashboard owner or connection owner can modify');
    }
    return d;
  }
}

function sanitizeRefresh(v: number | null | undefined): number | null {
  if (v == null || !Number.isFinite(v)) return null;
  // 10 seconds minimum — prevents a shared dashboard from DOS-ing the
  // backing DB. 86_400s cap = 1 day, long enough for any legitimate use.
  if (v < 10) return 10;
  if (v > 86_400) return 86_400;
  return Math.floor(v);
}

function clampInt(v: number, lo: number, hi: number): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return lo;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}
