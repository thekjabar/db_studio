import { Module, forwardRef } from '@nestjs/common';
import { DriversModule } from '../drivers/drivers.module';
import { RbacModule } from '../rbac/rbac.module';
import { AuditModule } from '../audit/audit.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { ConnectionsController } from './connections.controller';
import { ConnectionsService } from './connections.service';
import { IntrospectionController } from './introspection.controller';
import { PermissionsController } from './permissions.controller';
import { PermissionsService } from './permissions.service';
import { ColumnMasksController } from './column-masks.controller';
import { ColumnMasksService } from './column-masks.service';

@Module({
  imports: [DriversModule, RbacModule, forwardRef(() => AuditModule), forwardRef(() => WebhooksModule)],
  controllers: [ConnectionsController, IntrospectionController, PermissionsController, ColumnMasksController],
  providers: [ConnectionsService, PermissionsService, ColumnMasksService],
  exports: [ConnectionsService],
})
export class ConnectionsModule {}
