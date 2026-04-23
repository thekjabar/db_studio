import { Module } from '@nestjs/common';
import { ConnectionsModule } from '../connections/connections.module';
import { RbacModule } from '../rbac/rbac.module';
import { CsvImportController } from './csv-import.controller';
import { CsvImportService } from './csv-import.service';

@Module({
  imports: [ConnectionsModule, RbacModule],
  controllers: [CsvImportController],
  providers: [CsvImportService],
})
export class CsvImportModule {}
