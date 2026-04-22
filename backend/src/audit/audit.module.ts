import { Module, forwardRef } from '@nestjs/common';
import { AuditService } from './audit.service';
import { AuditRevertService } from './audit-revert.service';
import { AuditController } from './audit.controller';
import { RbacModule } from '../rbac/rbac.module';
import { ConnectionsModule } from '../connections/connections.module';

@Module({
  imports: [RbacModule, forwardRef(() => ConnectionsModule)],
  controllers: [AuditController],
  providers: [AuditService, AuditRevertService],
  exports: [AuditService],
})
export class AuditModule {}
