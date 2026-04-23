import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { CryptoModule } from '../crypto/crypto.module';
import { RbacModule } from '../rbac/rbac.module';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';
import { WebhookQueue } from './webhook.queue';
import { WebhookWorker } from './webhook.worker';

@Module({
  imports: [PrismaModule, CryptoModule, RbacModule],
  controllers: [WebhooksController],
  providers: [WebhooksService, WebhookQueue, WebhookWorker],
  exports: [WebhooksService],
})
export class WebhooksModule {}
