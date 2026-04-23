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
import { HealthController } from './common/health.controller';

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
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
