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
import { RowFiltersController } from './row-filters.controller';
import { RowFiltersService } from './row-filters.service';
import { SensitiveScanController } from './sensitive-scan.controller';

@Module({
  imports: [DriversModule, RbacModule, forwardRef(() => AuditModule), forwardRef(() => WebhooksModule)],
  controllers: [
    ConnectionsController,
    IntrospectionController,
    PermissionsController,
    ColumnMasksController,
    RowFiltersController,
    SensitiveScanController,
  ],
  providers: [ConnectionsService, PermissionsService, ColumnMasksService, RowFiltersService],
  exports: [ConnectionsService],
})
export class ConnectionsModule {}
