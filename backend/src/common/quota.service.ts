import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../config/config.service';

/**
 * Hard caps enforced at create-time so a single workspace can't exhaust host
 * resources. Limits are pulled from env so operators can tune without
 * redeploying code.
 */
@Injectable()
export class QuotaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cfg: AppConfigService,
  ) {}

  async assertCanCreateConnection(workspaceId: string | null): Promise<void> {
    if (!workspaceId) return; // Personal-workspace-less users can still create
    const count = await this.prisma.connection.count({ where: { workspaceId } });
    const cap = this.cfg.maxConnectionsPerWorkspace;
    if (count >= cap) {
      throw new ForbiddenException(
        `This workspace has reached the connection limit (${cap}). Upgrade or remove unused connections.`,
      );
    }
  }

  async assertCanCreateSchedule(userId: string): Promise<void> {
    const count = await this.prisma.scheduledQuery.count({ where: { ownerId: userId } });
    const cap = this.cfg.maxScheduledQueriesPerWorkspace;
    if (count >= cap) {
      throw new ForbiddenException(
        `You have reached the scheduled-queries limit (${cap}).`,
      );
    }
  }

  async assertCanCreateWebhook(connectionId: string): Promise<void> {
    const count = await this.prisma.webhook.count({ where: { connectionId } });
    const cap = this.cfg.maxWebhooksPerConnection;
    if (count >= cap) {
      throw new ForbiddenException(
        `This connection has reached the webhook limit (${cap}).`,
      );
    }
  }
}
