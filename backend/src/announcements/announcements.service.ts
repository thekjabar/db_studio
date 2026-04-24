import { Injectable, NotFoundException } from '@nestjs/common';
import { AnnouncementSeverity, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

interface Targeting {
  workspaceIds?: string[];
  userIds?: string[];
}

/**
 * Announcement composition + targeted delivery. `activeFor(userId)`
 * returns the announcements a specific user should see given targeting
 * rules; dismissed or seen rows are joined in so the banner hides itself
 * once interacted with. Operator CRUD is straightforward.
 */
@Injectable()
export class AnnouncementsService {
  constructor(private readonly prisma: PrismaService) {}

  async listOperator(limit: number, offset: number) {
    const [rows, total] = await Promise.all([
      this.prisma.announcement.findMany({
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.announcement.count(),
    ]);
    return { rows, total };
  }

  async createOperator(input: {
    operatorId: string;
    title: string;
    body: string;
    severity: AnnouncementSeverity;
    targeting: Targeting | null;
    startsAt: Date;
    endsAt: Date | null;
  }) {
    return this.prisma.announcement.create({
      data: {
        title: input.title,
        body: input.body,
        severity: input.severity,
        targeting: input.targeting as Prisma.InputJsonValue | undefined,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        createdByOperatorId: input.operatorId,
      },
    });
  }

  async updateOperator(id: string, patch: {
    title?: string;
    body?: string;
    severity?: AnnouncementSeverity;
    targeting?: Targeting | null;
    startsAt?: Date;
    endsAt?: Date | null;
  }) {
    const existing = await this.prisma.announcement.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException();
    const data: Prisma.AnnouncementUpdateInput = {};
    if (patch.title !== undefined) data.title = patch.title;
    if (patch.body !== undefined) data.body = patch.body;
    if (patch.severity !== undefined) data.severity = patch.severity;
    if (patch.targeting !== undefined) {
      // Prisma's JsonNullable wants `Prisma.JsonNull` for SQL NULL, and a
      // real value otherwise. Undefined means "don't change".
      data.targeting = patch.targeting === null ? Prisma.JsonNull : (patch.targeting as Prisma.InputJsonValue);
    }
    if (patch.startsAt !== undefined) data.startsAt = patch.startsAt;
    if (patch.endsAt !== undefined) data.endsAt = patch.endsAt;
    return this.prisma.announcement.update({ where: { id }, data });
  }

  async removeOperator(id: string) {
    await this.prisma.announcement.delete({ where: { id } }).catch(() => null);
    return { ok: true as const };
  }

  /**
   * The customer side: announcements that are currently live AND either
   * untargeted or targeted at this user, with their dismissal state
   * joined in. Sorted newest-first; the client shows the most severe
   * non-dismissed one as a banner and the rest in a bell dropdown.
   */
  async activeFor(userId: string, workspaceIds: string[]) {
    const now = new Date();
    const rows = await this.prisma.announcement.findMany({
      where: {
        startsAt: { lte: now },
        OR: [{ endsAt: null }, { endsAt: { gte: now } }],
      },
      orderBy: { startsAt: 'desc' },
    });
    const visible = rows.filter((a) => {
      const t = a.targeting as Targeting | null;
      if (!t) return true;
      if (t.userIds?.length && t.userIds.includes(userId)) return true;
      if (t.workspaceIds?.length && t.workspaceIds.some((w) => workspaceIds.includes(w))) return true;
      return false;
    });
    if (visible.length === 0) return [];
    const views = await this.prisma.announcementView.findMany({
      where: { userId, announcementId: { in: visible.map((a) => a.id) } },
    });
    const byId = new Map(views.map((v) => [v.announcementId, v]));
    return visible.map((a) => ({
      ...a,
      seen: !!byId.get(a.id)?.seenAt,
      dismissedAt: byId.get(a.id)?.dismissedAt ?? null,
    }));
  }

  async markSeen(userId: string, announcementId: string) {
    await this.prisma.announcementView.upsert({
      where: { announcementId_userId: { announcementId, userId } },
      create: { announcementId, userId, seenAt: new Date() },
      update: { seenAt: new Date() },
    });
    return { ok: true as const };
  }

  async dismiss(userId: string, announcementId: string) {
    await this.prisma.announcementView.upsert({
      where: { announcementId_userId: { announcementId, userId } },
      create: { announcementId, userId, seenAt: new Date(), dismissedAt: new Date() },
      update: { dismissedAt: new Date() },
    });
    return { ok: true as const };
  }
}
