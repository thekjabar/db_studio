import { Module } from '@nestjs/common';
import { AiService } from './ai.service';
import { AiController } from './ai.controller';
import { ConnectionsModule } from '../connections/connections.module';
import { RbacModule } from '../rbac/rbac.module';

@Module({
  imports: [ConnectionsModule, RbacModule],
  controllers: [AiController],
  providers: [AiService],
})
export class AiModule {}
