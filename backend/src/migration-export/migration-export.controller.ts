import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { IsOptional, IsString, Length } from 'class-validator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RbacGuard } from '../rbac/rbac.guard';
import { RequireRole } from '../rbac/rbac.decorator';
import { CurrentUser, AuthUser } from '../auth/decorators/current-user.decorator';
import { MigrationExportService, MigrationTarget } from './migration-export.service';
import { SnapshotService } from './snapshot.service';

class CreateSnapshotDto {
  @IsString() @Length(1, 200) name!: string;
  @IsOptional() @IsString() @Length(0, 100) schema?: string;
}

@Controller('connections/:id/migration-export')
@UseGuards(JwtAuthGuard, RbacGuard)
export class MigrationExportController {
  constructor(
    private readonly svc: MigrationExportService,
    private readonly snapshots: SnapshotService,
  ) {}

  @Get()
  @RequireRole('VIEWER')
  export(
    @Param('id') id: string,
    @Query('target') target: string | undefined,
    @Query('schema') schema: string | undefined,
  ) {
    const normalized: MigrationTarget =
      target === 'drizzle' || target === 'sql' ? target : 'prisma';
    return this.svc.export(id, normalized, schema || undefined);
  }

  @Get('snapshots')
  @RequireRole('VIEWER')
  listSnapshots(@Param('id') id: string) {
    return this.snapshots.list(id);
  }

  @Post('snapshots')
  @HttpCode(201)
  @RequireRole('EDITOR')
  createSnapshot(
    @Param('id') id: string,
    @Body() dto: CreateSnapshotDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.snapshots.create(id, user.id, dto);
  }

  @Delete('snapshots/:snapshotId')
  deleteSnapshot(@Param('id') id: string, @Param('snapshotId') snapshotId: string) {
    return this.snapshots.remove(id, snapshotId);
  }

  @Get('snapshots/:snapshotId/diff')
  @RequireRole('VIEWER')
  diff(@Param('id') id: string, @Param('snapshotId') snapshotId: string) {
    return this.snapshots.diffAgainstCurrent(id, snapshotId);
  }
}
