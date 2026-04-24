import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RbacService } from '../rbac/rbac.service';
import { Prisma, Role } from '@prisma/client';
import { QueuesService } from './queues.service';
import { QuotaService } from '../common/quota.service';
import type { AlertCondition } from './alert-evaluator';

// Very light cron validation — 5 space-separated fields. bullmq/cron-parser
// will reject invalid patterns at enqueue time with a clearer message.
const CRON_RE = /^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/;

export interface CreateScheduleInput {
  connectionId: string;
  name: string;
  cron: string;
  timezone?: string;
  sqlText: string;
  emailTo: string[];
  slackWebhook?: string;
  alertCondition?: AlertCondition | null;
  alertCooldownMin?: number | null;
  enabled?: boolean;
}

export interface UpdateScheduleInput {
  name?: string;
  cron?: string;
  timezone?: string | null;
  sqlText?: string;
  emailTo?: string[];
  slackWebhook?: string | null;
  alertCondition?: AlertCondition | null;
  alertCooldownMin?: number | null;
  enabled?: boolean;
}

@Injectable()
export class SchedulerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
    private readonly queues: QueuesService,
    private readonly quota: QuotaService,
  ) {}

  private async assertCanManage(userId: string, scheduleId: string) {
    const row = await this.prisma.scheduledQuery.findUnique({
      where: { id: scheduleId },
      select: { ownerId: true, connectionId: true },
    });
    if (!row) throw new NotFoundException('Schedule not found');
    if (row.ownerId === userId) return row;
    // Connection OWNER can also edit/remove a schedule someone else created.
    const role = await this.rbac.effectiveRole(userId, row.connectionId);
    if (role !== Role.OWNER) throw new ForbiddenException('Only schedule or connection owner can modify');
    return row;
  }

  async list(userId: string) {
    // Show the caller's schedules plus any on connections they own.
    const rows = await this.prisma.scheduledQuery.findMany({
      where: {
        OR: [
          { ownerId: userId },
          { connection: { ownerId: userId } },
        ],
      },
      include: {
        connection: { select: { id: true, name: true, dialect: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return rows;
  }

  async get(userId: string, id: string) {
    const row = await this.prisma.scheduledQuery.findUnique({
      where: { id },
      include: { connection: { select: { id: true, name: true, dialect: true } } },
    });
    if (!row) throw new NotFoundException();
    if (row.ownerId !== userId) {
      const role = await this.rbac.effectiveRole(userId, row.connectionId);
      if (!role) throw new ForbiddenException();
    }
    return row;
  }

  async create(userId: string, input: CreateScheduleInput) {
    if (!CRON_RE.test(input.cron)) throw new BadRequestException('Invalid cron expression');
    // Caller must have at least EDITOR rights on the connection — same bar as
    // running any SQL against it.
    await this.rbac.require(userId, input.connectionId, Role.EDITOR);
    await this.quota.assertCanCreateSchedule(userId);

    if (input.slackWebhook && !/^https:\/\/hooks\.slack\.com\//.test(input.slackWebhook)) {
      throw new BadRequestException('Slack webhook must be a hooks.slack.com URL');
    }
    const row = await this.prisma.scheduledQuery.create({
      data: {
        connectionId: input.connectionId,
        ownerId: userId,
        name: input.name,
        cron: input.cron,
        timezone: input.timezone ?? null,
        sqlText: input.sqlText,
        emailTo: input.emailTo.join(','),
        slackWebhook: input.slackWebhook ?? null,
        alertCondition: (input.alertCondition ?? undefined) as Prisma.InputJsonValue | undefined,
        alertCooldownMin: input.alertCooldownMin ?? null,
        enabled: input.enabled ?? true,
      },
    });
    if (row.enabled) await this.queues.upsertCron(row.id, row.cron, row.timezone);
    return row;
  }

  async update(userId: string, id: string, patch: UpdateScheduleInput) {
    await this.assertCanManage(userId, id);
    if (patch.cron && !CRON_RE.test(patch.cron)) throw new BadRequestException('Invalid cron expression');

    if (patch.slackWebhook && !/^https:\/\/hooks\.slack\.com\//.test(patch.slackWebhook)) {
      throw new BadRequestException('Slack webhook must be a hooks.slack.com URL');
    }
    const updated = await this.prisma.scheduledQuery.update({
      where: { id },
      data: {
        ...(patch.name !== undefined && { name: patch.name }),
        ...(patch.cron !== undefined && { cron: patch.cron }),
        ...(patch.timezone !== undefined && { timezone: patch.timezone }),
        ...(patch.sqlText !== undefined && { sqlText: patch.sqlText }),
        ...(patch.emailTo !== undefined && { emailTo: patch.emailTo.join(',') }),
        ...(patch.slackWebhook !== undefined && { slackWebhook: patch.slackWebhook }),
        ...(patch.alertCondition !== undefined && {
          alertCondition: (patch.alertCondition ?? Prisma.DbNull) as unknown as Prisma.InputJsonValue,
        }),
        ...(patch.alertCooldownMin !== undefined && { alertCooldownMin: patch.alertCooldownMin }),
        ...(patch.enabled !== undefined && { enabled: patch.enabled }),
      },
    });

    // Cron trigger follows enabled flag + any schedule param changes.
    if (updated.enabled) {
      await this.queues.upsertCron(updated.id, updated.cron, updated.timezone);
    } else {
      await this.queues.removeCron(updated.id);
    }
    return updated;
  }

  async remove(userId: string, id: string) {
    await this.assertCanManage(userId, id);
    await this.queues.removeCron(id);
    await this.prisma.scheduledQuery.delete({ where: { id } });
  }

  async runNow(userId: string, id: string) {
    await this.assertCanManage(userId, id);
    await this.queues.enqueueExec(id);
    return { queued: true };
  }

  async listRuns(userId: string, id: string, limit = 50) {
    await this.get(userId, id); // ACL check via get
    return this.prisma.scheduledQueryRun.findMany({
      where: { scheduleId: id },
      orderBy: { startedAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 200),
    });
  }
}
