import { Module } from '@nestjs/common';
import { NotebooksController } from './notebooks.controller';
import { NotebooksService } from './notebooks.service';
import { RbacModule } from '../rbac/rbac.module';

@Module({
  imports: [RbacModule],
  controllers: [NotebooksController],
  providers: [NotebooksService],
})
export class NotebooksModule {}
