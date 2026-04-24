import { Module } from '@nestjs/common';
import { DashboardsController, PublicDashboardsController } from './dashboards.controller';
import { DashboardsService } from './dashboards.service';
import { ConnectionsModule } from '../connections/connections.module';
import { RbacModule } from '../rbac/rbac.module';

@Module({
  imports: [ConnectionsModule, RbacModule],
  controllers: [DashboardsController, PublicDashboardsController],
  providers: [DashboardsService],
})
export class DashboardsModule {}
