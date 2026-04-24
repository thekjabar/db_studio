import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Invite-code issuance, consumption, and waitlist management. Separate
 * from AuthService so the signup flow only needs a single call:
 * `await invites.consume(code, email)` — throws on any failure reason
 * with a specific, testable message.
 */
@Injectable()
export class InviteCodesService {
  constructor(private readonly prisma: PrismaService) {}

  async listCodes(limit: number, offset: number) {
    const [rows, total] = await Promise.all([
      this.prisma.inviteCode.findMany({ orderBy: { createdAt: 'desc' }, take: limit, skip: offset }),
      this.prisma.inviteCode.count(),
    ]);
    return { rows, total };
  }

  async listWaitlist(limit: number, offset: number) {
    const [rows, total] = await Promise.all([
      this.prisma.waitlist.findMany({
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
        include: { inviteCode: { select: { code: true, usesRemaining: true } } },
      }),
      this.prisma.waitlist.count(),
    ]);
    return { rows, total };
  }

  async createCode(operatorId: string, input: {
    code?: string;
    maxUses?: number;
    expiresAt?: Date | null;
    assignedEmail?: string | null;
    note?: string | null;
    waitlistId?: string | null;
  }) {
    // Short, unambiguous default: 10 base32-ish chars. Operators can
    // also supply their own memorable code.
    const code = (input.code ?? randomBytes(6).toString('base64url')).toUpperCase();
    const maxUses = input.maxUses ?? 1;
    return this.prisma.inviteCode.create({
      data: {
        code,
        maxUses,
        usesRemaining: maxUses,
        expiresAt: input.expiresAt ?? null,
        assignedEmail: input.assignedEmail ?? null,
        note: input.note ?? null,
        waitlistId: input.waitlistId ?? null,
        createdByOperatorId: operatorId,
      },
    });
  }

  async addToWaitlist(email: string, metadata?: Record<string, unknown>) {
    return this.prisma.waitlist.upsert({
      where: { email: email.toLowerCase() },
      create: { email: email.toLowerCase(), metadata: metadata as never },
      update: {},
    });
  }

  async inviteWaitlistEntry(operatorId: string, waitlistId: string, maxUses = 1) {
    const entry = await this.prisma.waitlist.findUnique({ where: { id: waitlistId } });
    if (!entry) throw new NotFoundException();
    const code = await this.createCode(operatorId, {
      assignedEmail: entry.email,
      maxUses,
      waitlistId,
    });
    await this.prisma.waitlist.update({
      where: { id: waitlistId },
      data: { invitedAt: new Date() },
    });
    return code;
  }

  async deleteCode(code: string) {
    await this.prisma.inviteCode.delete({ where: { code } }).catch(() => null);
    return { ok: true as const };
  }

  /**
   * Atomically validate and decrement. Throws a clear error on each
   * failure mode so the signup form can show the right message.
   */
  async consume(code: string, email: string) {
    const normalized = code.trim().toUpperCase();
    if (!normalized) throw new BadRequestException('Invite code required');
    const row = await this.prisma.inviteCode.findUnique({ where: { code: normalized } });
    if (!row) throw new BadRequestException('Invite code not found');
    if (row.expiresAt && row.expiresAt < new Date()) throw new BadRequestException('Invite code expired');
    if (row.usesRemaining !== 0 && row.usesRemaining <= 0) throw new BadRequestException('Invite code already used');
    if (row.assignedEmail && row.assignedEmail.toLowerCase() !== email.toLowerCase()) {
      throw new BadRequestException('Invite code does not match this email');
    }
    // 0 = unlimited; other values decrement. Update conditionally so two
    // parallel signups don't race the counter below zero.
    if (row.maxUses !== 0) {
      const result = await this.prisma.inviteCode.updateMany({
        where: { code: normalized, usesRemaining: { gt: 0 } },
        data: { usesRemaining: { decrement: 1 } },
      });
      if (result.count === 0) throw new BadRequestException('Invite code already used');
    }
    return { ok: true as const };
  }
}
