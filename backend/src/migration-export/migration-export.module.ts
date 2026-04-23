import { Module } from '@nestjs/common';
import { ConnectionsModule } from '../connections/connections.module';
import { RbacModule } from '../rbac/rbac.module';
import { MigrationExportController } from './migration-export.controller';
import { MigrationExportService } from './migration-export.service';
import { SnapshotService } from './snapshot.service';

@Module({
  imports: [ConnectionsModule, RbacModule],
  controllers: [MigrationExportController],
  providers: [MigrationExportService, SnapshotService],
})
export class MigrationExportModule {}
