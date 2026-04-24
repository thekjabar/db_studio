import { Module } from '@nestjs/common';
import { AiService } from './ai.service';
import { AiController } from './ai.controller';
import { AiChatService } from './ai-chat.service';
import { AiChatController } from './ai-chat.controller';
import { AiProviderFactory } from './providers/ai-provider.factory';
import { ConnectionsModule } from '../connections/connections.module';
import { RbacModule } from '../rbac/rbac.module';
import { OperatorModule } from '../operator/operator.module';

@Module({
  imports: [ConnectionsModule, RbacModule, OperatorModule],
  controllers: [AiController, AiChatController],
  providers: [AiService, AiChatService, AiProviderFactory],
})
export class AiModule {}
