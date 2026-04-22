import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class CommentsService {
  constructor(private readonly prisma: PrismaService) {}

  private validateTarget(target: string): void {
    if (!/^(table|column|row):/.test(target)) {
      throw new BadRequestException('target must start with table: / column: / row:');
    }
    if (target.length > 500) {
      throw new BadRequestException('target too long');
    }
  }

  async list(connectionId: string, target?: string) {
    return this.prisma.comment.findMany({
      where: { connectionId, ...(target ? { target } : {}) },
      orderBy: { createdAt: 'desc' },
      include: { user: { select: { email: true, displayName: true } } },
    });
  }

  async create(connectionId: string, userId: string, target: string, body: string) {
    this.validateTarget(target);
    if (!body.trim()) throw new BadRequestException('body is required');
    if (body.length > 5_000) throw new BadRequestException('body too long');
    return this.prisma.comment.create({
      data: { connectionId, userId, target, body },
      include: { user: { select: { email: true, displayName: true } } },
    });
  }

  async update(userId: string, id: string, body: string) {
    const c = await this.prisma.comment.findUnique({ where: { id } });
    if (!c) throw new NotFoundException();
    if (c.userId !== userId) throw new ForbiddenException('Not your comment');
    if (!body.trim()) throw new BadRequestException('body is required');
    return this.prisma.comment.update({
      where: { id },
      data: { body },
      include: { user: { select: { email: true, displayName: true } } },
    });
  }

  async remove(userId: string, id: string) {
    const c = await this.prisma.comment.findUnique({ where: { id } });
    if (!c) throw new NotFoundException();
    if (c.userId !== userId) throw new ForbiddenException('Not your comment');
    await this.prisma.comment.delete({ where: { id } });
  }

  /** Map of target -> count, for badges in the UI. */
  async counts(connectionId: string) {
    const rows = await this.prisma.comment.groupBy({
      by: ['target'],
      where: { connectionId },
      _count: { _all: true },
    });
    const out: Record<string, number> = {};
    for (const r of rows) out[r.target] = r._count._all;
    return out;
  }
}
