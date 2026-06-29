import { Module } from '@nestjs/common';
import { DbUsersController } from './db-users.controller';
import { DbUsersService } from './db-users.service';
import { ConnectionsModule } from '../connections/connections.module';
import { AuditModule } from '../audit/audit.module';
import { RbacModule } from '../rbac/rbac.module';

@Module({
  imports: [ConnectionsModule, AuditModule, RbacModule],
  controllers: [DbUsersController],
  providers: [DbUsersService],
})
export class DbUsersModule {}
