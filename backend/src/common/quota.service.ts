import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../config/config.service';
import { PlanService } from '../billing/plan.service';

/**
 * Hard caps enforced at create-time so a single workspace can't exhaust host
 * resources. Limits come from the workspace's effective plan tier (PlanConfig,
 * operator-editable); the env caps remain as an absolute host ceiling that a
 * misconfigured/oversized plan can never exceed.
 */
@Injectable()
export class QuotaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cfg: AppConfigService,
    private readonly plans: PlanService,
  ) {}

  async assertCanCreateConnection(workspaceId: string | null): Promise<void> {
    if (!workspaceId) return; // Personal-workspace-less users can still create
    const count = await this.prisma.connection.count({ where: { workspaceId } });
    const { config } = await this.plans.forWorkspace(workspaceId);
    const cap = Math.min(config.maxConnections, this.cfg.maxConnectionsPerWorkspace);
    if (count >= cap) {
      throw new ForbiddenException(
        `Your ${config.name} plan allows ${config.maxConnections} connection(s). Upgrade your plan or remove unused connections.`,
      );
    }
  }

  async assertCanCreateSchedule(userId: string): Promise<void> {
    const count = await this.prisma.scheduledQuery.count({ where: { ownerId: userId } });
    const config = await this.plans.forUser(userId);
    const cap = Math.min(config.maxScheduledQueries, this.cfg.maxScheduledQueriesPerWorkspace);
    if (count >= cap) {
      throw new ForbiddenException(
        `Your ${config.name} plan allows ${config.maxScheduledQueries} scheduled queries. Upgrade to add more.`,
      );
    }
  }

  async assertCanCreateWebhook(connectionId: string): Promise<void> {
    const count = await this.prisma.webhook.count({ where: { connectionId } });
    const conn = await this.prisma.connection.findUnique({
      where: { id: connectionId },
      select: { workspaceId: true },
    });
    const config = conn?.workspaceId
      ? (await this.plans.forWorkspace(conn.workspaceId)).config
      : await this.plans.config('FREE');
    const cap = Math.min(config.maxWebhooksPerConnection, this.cfg.maxWebhooksPerConnection);
    if (count >= cap) {
      throw new ForbiddenException(
        `Your ${config.name} plan allows ${config.maxWebhooksPerConnection} webhook(s) per connection. Upgrade to add more.`,
      );
    }
  }
}
