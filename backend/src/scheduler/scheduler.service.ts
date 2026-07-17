import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RbacService } from '../rbac/rbac.service';
import { Prisma, Role } from '@prisma/client';
import { QueuesService } from './queues.service';
import { QuotaService } from '../common/quota.service';
import { SqlClassifierService } from '../query/sql-classifier.service';
import type { AlertCondition } from './alert-evaluator';

// Very light cron validation — 5 space-separated fields. bullmq/cron-parser
// will reject invalid patterns at enqueue time with a clearer message.
const CRON_RE = /^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/;

export interface CreateScheduleInput {
  connectionId: string;
  name: string;
  cron: string;
  timezone?: string;
  schemaName?: string | null;
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
  schemaName?: string | null;
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
    private readonly classifier: SqlClassifierService,
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

  /**
   * A scheduled statement runs unattended as OWNER, so a non-owner may not
   * schedule a destructive/DDL statement on a connection that requires review.
   * There's no interactive approval step on a cron, so this refuses outright
   * rather than accepting a review-request id.
   */
  private async assertSchedulableSql(userId: string, connectionId: string, sql: string) {
    const conn = await this.prisma.connection.findUnique({
      where: { id: connectionId },
      select: { dialect: true, requireReview: true },
    });
    if (!conn?.requireReview) return;
    const role = await this.rbac.effectiveRole(userId, connectionId);
    if (role === Role.OWNER) return;
    const cls = this.classifier.classify(sql, conn.dialect);
    if (cls.kind === 'DESTRUCTIVE' || cls.kind === 'DDL' || cls.kind === 'UNKNOWN') {
      throw new ForbiddenException({
        code: 'REVIEW_REQUIRED',
        message:
          'This connection requires approval for destructive statements, so only the connection owner can schedule one.',
        classification: cls,
      });
    }
  }

  async create(userId: string, input: CreateScheduleInput) {
    if (!CRON_RE.test(input.cron)) throw new BadRequestException('Invalid cron expression');
    // Caller must have at least EDITOR rights on the connection — same bar as
    // running any SQL against it.
    await this.rbac.require(userId, input.connectionId, Role.EDITOR);
    await this.quota.assertCanCreateSchedule(userId);
    // SECURITY: the worker executes this SQL as OWNER on a timer, so scheduling
    // must face the same approval bar as running it directly. Without this an
    // EDITOR could cron `DROP TABLE x` and skip the review gate that
    // /query enforces.
    await this.assertSchedulableSql(userId, input.connectionId, input.sqlText);

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
        schemaName: input.schemaName ?? null,
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
    const existing = await this.assertCanManage(userId, id);
    if (patch.cron && !CRON_RE.test(patch.cron)) throw new BadRequestException('Invalid cron expression');
    // Re-check on edit too — otherwise the gate is trivially skipped by creating
    // a harmless SELECT schedule and then swapping in the destructive SQL.
    if (patch.sqlText !== undefined) {
      await this.assertSchedulableSql(userId, existing.connectionId, patch.sqlText);
    }

    if (patch.slackWebhook && !/^https:\/\/hooks\.slack\.com\//.test(patch.slackWebhook)) {
      throw new BadRequestException('Slack webhook must be a hooks.slack.com URL');
    }
    const updated = await this.prisma.scheduledQuery.update({
      where: { id },
      data: {
        ...(patch.name !== undefined && { name: patch.name }),
        ...(patch.cron !== undefined && { cron: patch.cron }),
        ...(patch.timezone !== undefined && { timezone: patch.timezone }),
        ...(patch.schemaName !== undefined && { schemaName: patch.schemaName }),
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
