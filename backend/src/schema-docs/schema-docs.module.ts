import { Module } from '@nestjs/common';
import { RbacModule } from '../rbac/rbac.module';
import { SchemaDocsController } from './schema-docs.controller';
import { SchemaDocsService } from './schema-docs.service';

@Module({
  imports: [RbacModule],
  controllers: [SchemaDocsController],
  providers: [SchemaDocsService],
})
export class SchemaDocsModule {}
