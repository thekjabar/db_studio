import { Module } from '@nestjs/common';
import { RbacService } from './rbac.service';
import { RbacGuard } from './rbac.guard';

@Module({
  providers: [RbacService, RbacGuard],
  exports: [RbacService, RbacGuard],
})
export class RbacModule {}
