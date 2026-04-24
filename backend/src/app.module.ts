import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AppConfigModule } from './config/config.module';
import { AppConfigService } from './config/config.service';
import { PrismaModule } from './prisma/prisma.module';
import { CryptoModule } from './crypto/crypto.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { ConnectionsModule } from './connections/connections.module';
import { DriversModule } from './drivers/drivers.module';
import { QueryModule } from './query/query.module';
import { SchemaModule } from './schema/schema.module';
import { AuditModule } from './audit/audit.module';
import { RealtimeModule } from './realtime/realtime.module';
import { RbacModule } from './rbac/rbac.module';
import { AiModule } from './ai/ai.module';
import { CommentsModule } from './comments/comments.module';
import { WorkspacesModule } from './workspaces/workspaces.module';
import { SchedulerModule } from './scheduler/scheduler.module';
import { CsvImportModule } from './csv-import/csv-import.module';
import { BackupModule } from './backup/backup.module';
import { SlowQueryModule } from './slow-query/slow-query.module';
import { FederatedModule } from './federated/federated.module';
import { MigrationExportModule } from './migration-export/migration-export.module';
import { ExportsModule } from './exports/exports.module';
import { AdminModule } from './admin/admin.module';
import { DashboardsModule } from './dashboards/dashboards.module';
import { HealthMonitorModule } from './health-monitor/health-monitor.module';
import { QueryReviewModule } from './query-review/query-review.module';
import { NotebooksModule } from './notebooks/notebooks.module';
import { SchemaDocsModule } from './schema-docs/schema-docs.module';
import { StatusModule } from './status/status.module';
import { ComplianceModule } from './compliance/compliance.module';
import { OrganizationsModule } from './organizations/organizations.module';
import { RedisModule } from './redis/redis.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { ApiKeysModule } from './api-keys/api-keys.module';
import { CommonModule } from './common/common.module';
import { HealthController } from './common/health.controller';
import { OperatorModule } from './operator/operator.module';

@Module({
  imports: [
    AppConfigModule,
    ThrottlerModule.forRootAsync({
      inject: [AppConfigService],
      useFactory: (c: AppConfigService) => ({
        throttlers: [
          // Global baseline — applies to every endpoint unless overridden.
          { name: 'default', ttl: c.rateLimitTtlSec * 1000, limit: c.rateLimitMax },
          // Tighter bucket for expensive endpoints: raw query, schema writes, bulk delete.
          { name: 'heavy', ttl: 60_000, limit: 30 },
        ],
      }),
    }),
    PrismaModule,
    CryptoModule,
    AuthModule,
    UsersModule,
    ConnectionsModule,
    DriversModule,
    QueryModule,
    SchemaModule,
    AuditModule,
    RealtimeModule,
    RbacModule,
    AiModule,
    CommentsModule,
    WorkspacesModule,
    SchedulerModule,
    CsvImportModule,
    BackupModule,
    SlowQueryModule,
    FederatedModule,
    MigrationExportModule,
    ExportsModule,
    AdminModule,
    DashboardsModule,
    HealthMonitorModule,
    QueryReviewModule,
    NotebooksModule,
    SchemaDocsModule,
    StatusModule,
    ComplianceModule,
    OrganizationsModule,
    RedisModule,
    WebhooksModule,
    ApiKeysModule,
    CommonModule,
    OperatorModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
