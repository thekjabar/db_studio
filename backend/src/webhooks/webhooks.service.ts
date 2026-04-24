import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { Role, WebhookEvent } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../crypto/crypto.service';
import { RbacService } from '../rbac/rbac.service';
import { WebhookQueue } from './webhook.queue';
import { QuotaService } from '../common/quota.service';

const PURPOSE = (id: string) => `webhook:${id}`;
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export interface CreateWebhookInput {
  name: string;
  url: string;
  schemaName: string;
  tableName: string;
  events: WebhookEvent[];
  enabled?: boolean;
}

export interface UpdateWebhookInput {
  name?: string;
  url?: string;
  schemaName?: string;
  tableName?: string;
  events?: WebhookEvent[];
  enabled?: boolean;
  /** If set, rotate the secret to this value. */
  secret?: string;
}

@Injectable()
export class WebhooksService {
  private readonly log = new Logger(WebhooksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly rbac: RbacService,
    private readonly queue: WebhookQueue,
    private readonly quota: QuotaService,
  ) {}

  private validateInput(input: CreateWebhookInput | UpdateWebhookInput) {
    if ('schemaName' in input && input.schemaName !== undefined && !IDENT_RE.test(input.schemaName)) {
      throw new BadRequestException('Invalid schema name');
    }
    if ('tableName' in input && input.tableName !== undefined && !IDENT_RE.test(input.tableName)) {
      throw new BadRequestException('Invalid table name');
    }
    if ('url' in input && input.url !== undefined) {
      let parsed: URL;
      try {
        parsed = new URL(input.url);
      } catch {
        throw new BadRequestException('URL must be a valid absolute URL');
      }
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        throw new BadRequestException('URL must be http(s)');
      }
    }
  }

  async create(userId: string, connectionId: string, input: CreateWebhookInput) {
    await this.rbac.require(userId, connectionId, Role.OWNER);
    this.validateInput(input);
    if (input.events.length === 0) {
      throw new BadRequestException('At least one event must be selected');
    }
    await this.quota.assertCanCreateWebhook(connectionId);

    const secret = randomBytes(32).toString('base64url');
    // Encrypt at write time. We use a random purpose since the webhook id
    // doesn't exist yet; we'll re-encrypt with the id-bound purpose after create.
    const tempCt = await this.crypto.encrypt(secret, 'webhook:new');
    const row = await this.prisma.webhook.create({
      data: {
        connectionId,
        ownerId: userId,
        name: input.name,
        url: input.url,
        secretCt: tempCt,
        schemaName: input.schemaName,
        tableName: input.tableName,
        events: input.events,
        enabled: input.enabled ?? true,
      },
    });
    const finalCt = await this.crypto.encrypt(secret, PURPOSE(row.id));
    const updated = await this.prisma.webhook.update({
      where: { id: row.id },
      data: { secretCt: finalCt },
    });
    return { ...this.sanitize(updated), secret };
  }

  async list(userId: string, connectionId: string) {
    await this.rbac.require(userId, connectionId, Role.VIEWER);
    const rows = await this.prisma.webhook.findMany({
      where: { connectionId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.sanitize(r));
  }

  async get(userId: string, id: string) {
    const row = await this.prisma.webhook.findUnique({ where: { id } });
    if (!row) throw new NotFoundException();
    await this.rbac.require(userId, row.connectionId, Role.VIEWER);
    return this.sanitize(row);
  }

  async update(userId: string, id: string, patch: UpdateWebhookInput) {
    const existing = await this.prisma.webhook.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException();
    if (existing.ownerId !== userId) {
      const role = await this.rbac.effectiveRole(userId, existing.connectionId);
      if (role !== Role.OWNER) throw new ForbiddenException('Only the owner or connection owner can edit');
    }
    this.validateInput(patch);

    const data: Record<string, unknown> = {};
    if (patch.name !== undefined) data.name = patch.name;
    if (patch.url !== undefined) data.url = patch.url;
    if (patch.schemaName !== undefined) data.schemaName = patch.schemaName;
    if (patch.tableName !== undefined) data.tableName = patch.tableName;
    if (patch.events !== undefined) data.events = patch.events;
    if (patch.enabled !== undefined) data.enabled = patch.enabled;
    if (patch.secret) data.secretCt = await this.crypto.encrypt(patch.secret, PURPOSE(id));

    const updated = await this.prisma.webhook.update({ where: { id }, data });
    return this.sanitize(updated);
  }

  async remove(userId: string, id: string) {
    const existing = await this.prisma.webhook.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException();
    if (existing.ownerId !== userId) {
      const role = await this.rbac.effectiveRole(userId, existing.connectionId);
      if (role !== Role.OWNER) throw new ForbiddenException();
    }
    await this.prisma.webhook.delete({ where: { id } });
  }

  async listDeliveries(userId: string, id: string, limit = 50) {
    const w = await this.prisma.webhook.findUnique({ where: { id } });
    if (!w) throw new NotFoundException();
    await this.rbac.require(userId, w.connectionId, Role.VIEWER);
    return this.prisma.webhookDelivery.findMany({
      where: { webhookId: id },
      orderBy: { startedAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 200),
    });
  }

  async testFire(userId: string, id: string) {
    const w = await this.prisma.webhook.findUnique({ where: { id } });
    if (!w) throw new NotFoundException();
    if (w.ownerId !== userId) {
      const role = await this.rbac.effectiveRole(userId, w.connectionId);
      if (role !== Role.OWNER) throw new ForbiddenException();
    }
    // Enqueue a synthetic test event with a clear payload.
    await this.queue.enqueueFromService({
      webhookId: id,
      event: WebhookEvent.ROW_INSERT,
      payload: {
        test: true,
        message: 'This is a manual test delivery triggered from the UI.',
        sentAt: new Date().toISOString(),
      },
    });
    return { queued: true };
  }

  /**
   * Fire-and-forget dispatch used by the row-mutation controllers. Looks up
   * matching webhooks and enqueues a delivery job for each. Never throws —
   * webhook errors must not break the underlying operation.
   */
  async dispatch(args: {
    connectionId: string;
    schemaName: string;
    tableName: string;
    event: WebhookEvent;
    userId?: string;
    pk?: Record<string, unknown> | null;
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
    bulk?: number;
  }): Promise<void> {
    try {
      const hooks = await this.prisma.webhook.findMany({
        where: {
          connectionId: args.connectionId,
          schemaName: args.schemaName,
          tableName: args.tableName,
          enabled: true,
          events: { has: args.event },
        },
        select: { id: true },
      });
      if (hooks.length === 0) return;
      const payload = {
        event: args.event,
        connectionId: args.connectionId,
        schema: args.schemaName,
        table: args.tableName,
        userId: args.userId ?? null,
        pk: args.pk ?? null,
        before: args.before ?? null,
        after: args.after ?? null,
        bulkSize: args.bulk ?? null,
        timestamp: new Date().toISOString(),
      };
      for (const h of hooks) {
        await this.queue.enqueueFromService({
          webhookId: h.id,
          event: args.event,
          payload,
        });
      }
    } catch (err) {
      this.log.warn(`webhook dispatch failed: ${(err as Error).message}`);
    }
  }

  private sanitize(w: {
    id: string;
    connectionId: string;
    ownerId: string;
    name: string;
    url: string;
    schemaName: string;
    tableName: string;
    events: WebhookEvent[];
    enabled: boolean;
    lastFiredAt: Date | null;
    lastStatus: string | null;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      id: w.id,
      connectionId: w.connectionId,
      ownerId: w.ownerId,
      name: w.name,
      url: w.url,
      schemaName: w.schemaName,
      tableName: w.tableName,
      events: w.events,
      enabled: w.enabled,
      lastFiredAt: w.lastFiredAt,
      lastStatus: w.lastStatus,
      createdAt: w.createdAt,
      updatedAt: w.updatedAt,
    };
  }
}
