import { Module, forwardRef } from '@nestjs/common';
import { DriversModule } from '../drivers/drivers.module';
import { RbacModule } from '../rbac/rbac.module';
import { AuditModule } from '../audit/audit.module';
import { ConnectionsController } from './connections.controller';
import { ConnectionsService } from './connections.service';
import { IntrospectionController } from './introspection.controller';

@Module({
  imports: [DriversModule, RbacModule, forwardRef(() => AuditModule)],
  controllers: [ConnectionsController, IntrospectionController],
  providers: [ConnectionsService],
  exports: [ConnectionsService],
})
export class ConnectionsModule {}
