import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ReviewStatus, Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RbacService } from '../rbac/rbac.service';
import { ConnectionsService } from '../connections/connections.service';
import { SqlClassifierService } from '../query/sql-classifier.service';

const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000; // 24h — approved but not-yet-run requests expire

@Injectable()
export class QueryReviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
    private readonly connections: ConnectionsService,
    private readonly classifier: SqlClassifierService,
  ) {}

  async submit(userId: string, connectionId: string, sqlText: string, reason?: string) {
    if (!sqlText.trim()) throw new BadRequestException('SQL required');
    await this.rbac.require(userId, connectionId, Role.EDITOR);
    const conn = await this.connections.get(connectionId);
    const cls = this.classifier.classify(sqlText, conn.dialect);
    return this.prisma.queryReviewRequest.create({
      data: {
        connectionId,
        requesterId: userId,
        sqlText,
        classification: cls.kind,
        reason: reason?.slice(0, 1000) ?? null,
      },
    });
  }

  async list(userId: string, connectionId: string, status?: ReviewStatus) {
    await this.rbac.require(userId, connectionId, Role.VIEWER);
    return this.prisma.queryReviewRequest.findMany({
      where: { connectionId, ...(status ? { status } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: {
        requester: { select: { id: true, email: true, displayName: true } },
        reviewer: { select: { id: true, email: true, displayName: true } },
      },
    });
  }

  async pendingMine(userId: string) {
    // Requests the user needs to review: they are OWNER on the connection
    // and the request is PENDING. Useful for a top-bar inbox.
    const rows = await this.prisma.queryReviewRequest.findMany({
      where: {
        status: ReviewStatus.PENDING,
        OR: [
          { connection: { ownerId: userId } },
          { connection: { members: { some: { userId, role: Role.OWNER } } } },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: 100,
      include: {
        connection: { select: { id: true, name: true, dialect: true } },
        requester: { select: { id: true, email: true, displayName: true } },
      },
    });
    return rows;
  }

  async approve(userId: string, id: string, comment?: string) {
    const req = await this.assertCanReview(userId, id);
    if (req.status !== ReviewStatus.PENDING) {
      throw new BadRequestException(`Cannot approve a ${req.status.toLowerCase()} request`);
    }
    return this.prisma.queryReviewRequest.update({
      where: { id },
      data: {
        status: ReviewStatus.APPROVED,
        reviewerId: userId,
        approvedAt: new Date(),
        reviewComment: comment?.slice(0, 1000) ?? null,
      },
    });
  }

  async reject(userId: string, id: string, comment?: string) {
    const req = await this.assertCanReview(userId, id);
    if (req.status !== ReviewStatus.PENDING) {
      throw new BadRequestException(`Cannot reject a ${req.status.toLowerCase()} request`);
    }
    return this.prisma.queryReviewRequest.update({
      where: { id },
      data: {
        status: ReviewStatus.REJECTED,
        reviewerId: userId,
        reviewComment: comment?.slice(0, 1000) ?? null,
      },
    });
  }

  /** Lookup + expire-check without changing status. Returns a request only if
   *  it's still runnable (APPROVED, not expired). Used by QueryController
   *  right before it hands SQL to the driver. */
  async fetchRunnable(userId: string, id: string) {
    const req = await this.prisma.queryReviewRequest.findUnique({ where: { id } });
    if (!req) throw new NotFoundException('Review request not found');
    if (req.requesterId !== userId) {
      throw new ForbiddenException('Only the original requester can run this request');
    }
    if (req.status === ReviewStatus.EXECUTED) {
      throw new BadRequestException('This request has already been executed');
    }
    if (req.status !== ReviewStatus.APPROVED) {
      throw new BadRequestException(`Request is ${req.status.toLowerCase()}; not runnable`);
    }
    const approvedAt = req.approvedAt?.getTime() ?? 0;
    if (Date.now() - approvedAt > APPROVAL_TTL_MS) {
      await this.prisma.queryReviewRequest.update({
        where: { id },
        data: { status: ReviewStatus.EXPIRED },
      });
      throw new BadRequestException('Approval expired; submit a fresh request');
    }
    return req;
  }

  /** Mark executed + record affected rows. Caller (QueryController) does this
   *  after the driver returns. */
  async markExecuted(id: string, rowsAffected: number | null) {
    await this.prisma.queryReviewRequest.update({
      where: { id },
      data: {
        status: ReviewStatus.EXECUTED,
        executedAt: new Date(),
        executedRowsAffected: rowsAffected ?? null,
      },
    });
  }

  private async assertCanReview(userId: string, id: string) {
    const req = await this.prisma.queryReviewRequest.findUnique({ where: { id } });
    if (!req) throw new NotFoundException('Review request not found');
    if (req.requesterId === userId) {
      // Self-review is prohibited — requesters can't approve their own requests.
      throw new ForbiddenException('You cannot review your own request');
    }
    const role = await this.rbac.effectiveRole(userId, req.connectionId);
    if (role !== Role.OWNER) {
      throw new ForbiddenException('Only connection owners can review requests');
    }
    return req;
  }
}
