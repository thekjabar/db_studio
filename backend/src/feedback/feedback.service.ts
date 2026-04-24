import { Injectable, NotFoundException } from '@nestjs/common';
import { FeedbackCategory, FeedbackStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../scheduler/email.service';

/**
 * Customer feedback intake and operator triage. The customer side is a
 * single POST; the operator side is list + reply + internal-note edit +
 * status change. Reply emails flow through the existing SMTP transporter
 * when configured; when not, the operator can copy the text to email
 * manually. Either way we store the reply so the audit trail stays whole.
 */
@Injectable()
export class FeedbackService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
  ) {}

  async submit(input: {
    userId: string | null;
    email: string | null;
    category: FeedbackCategory;
    message: string;
    sourcePath: string | null;
  }) {
    return this.prisma.feedback.create({
      data: {
        userId: input.userId,
        email: input.email,
        category: input.category,
        message: input.message,
        sourcePath: input.sourcePath,
      },
    });
  }

  async list(params: { status?: FeedbackStatus; limit: number; offset: number }) {
    const where = params.status ? { status: params.status } : {};
    const [rows, total, unread] = await Promise.all([
      this.prisma.feedback.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: params.limit,
        skip: params.offset,
        include: { user: { select: { email: true, displayName: true, id: true } } },
      }),
      this.prisma.feedback.count({ where }),
      this.prisma.feedback.count({ where: { status: 'NEW' } }),
    ]);
    return { rows, total, unread };
  }

  async get(id: string) {
    const row = await this.prisma.feedback.findUnique({
      where: { id },
      include: { user: { select: { id: true, email: true, displayName: true } } },
    });
    if (!row) throw new NotFoundException();
    return row;
  }

  async setStatus(id: string, status: FeedbackStatus) {
    await this.prisma.feedback.update({ where: { id }, data: { status } });
    return { ok: true as const };
  }

  async setNote(id: string, internalNotes: string) {
    await this.prisma.feedback.update({ where: { id }, data: { internalNotes } });
    return { ok: true as const };
  }

  async reply(id: string, operatorId: string, body: string) {
    const row = await this.get(id);
    // Prefer the account email if the user still exists, otherwise the
    // snapshot email saved at submit time.
    const to = row.user?.email ?? row.email;
    let sent = false;
    let error: string | null = null;
    if (to && this.email.enabled) {
      try {
        await this.email.send({
          to: [to],
          subject: `Re: your feedback`,
          body,
        });
        sent = true;
      } catch (e) {
        error = (e as Error).message;
      }
    }
    await this.prisma.feedback.update({
      where: { id },
      data: {
        replyText: body,
        repliedAt: new Date(),
        repliedByOperatorId: operatorId,
        status: 'ANSWERED',
      },
    });
    return { sent, copyToManualEmail: !sent, error };
  }
}
