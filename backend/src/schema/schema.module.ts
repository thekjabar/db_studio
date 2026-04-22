import { Module } from '@nestjs/common';
import { ConnectionsModule } from '../connections/connections.module';
import { AuditModule } from '../audit/audit.module';
import { RbacModule } from '../rbac/rbac.module';
import { SchemaController } from './schema.controller';

@Module({
  imports: [ConnectionsModule, AuditModule, RbacModule],
  controllers: [SchemaController],
})
export class SchemaModule {}
