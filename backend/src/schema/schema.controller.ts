import {
  BadRequestException, Body, Controller, Delete, Param, Patch, Post, Query, Req, UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { IsArray, IsBoolean, IsOptional, IsString, Length, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { Role } from '@prisma/client';
import { ConnectionsService } from '../connections/connections.service';
import { AuditService } from '../audit/audit.service';
import { RbacGuard } from '../rbac/rbac.guard';
import { RequireRole } from '../rbac/rbac.decorator';
import { CurrentUser, AuthUser } from '../auth/decorators/current-user.decorator';
import { AlterTableSpec, CreateTableSpec } from '../drivers/driver.interface';

class ColumnSpecDto {
  @IsString() @Length(1, 63) name!: string;
  @IsString() @Length(1, 128) type!: string;
  @IsOptional() @IsBoolean() nullable?: boolean;
  @IsOptional() @IsString() default?: string | null;
  @IsOptional() @IsBoolean() defaultIsExpression?: boolean;
  @IsOptional() @IsBoolean() primaryKey?: boolean;
  @IsOptional() @IsBoolean() unique?: boolean;
  @IsOptional() @IsString() @Length(0, 1024) check?: string | null;
  @IsOptional() @IsString() @Length(0, 1024) comment?: string | null;
}

class ForeignKeySpecDto {
  @IsArray() @IsString({ each: true }) columns!: string[];
  @IsOptional() @IsString() refSchema?: string;
  @IsString() refTable!: string;
  @IsArray() @IsString({ each: true }) refColumns!: string[];
  @IsOptional() @IsString() onDelete?: string;
  @IsOptional() @IsString() onUpdate?: string;
}

class CreateTableDto {
  @IsString() @Length(1, 63) schema!: string;
  @IsString() @Length(1, 63) name!: string;
  @IsArray() @ValidateNested({ each: true }) @Type(() => ColumnSpecDto) columns!: ColumnSpecDto[];
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => ForeignKeySpecDto) foreignKeys?: ForeignKeySpecDto[];
  @IsOptional() @IsBoolean() confirm?: boolean;
}

class AlterColumnDto {
  @IsString() name!: string;
  @IsOptional() @IsString() type?: string;
  @IsOptional() @IsBoolean() nullable?: boolean;
  @IsOptional() default?: string | null;
  @IsOptional() @IsString() @Length(0, 1024) check?: string | null;
  @IsOptional() @IsString() @Length(0, 1024) comment?: string | null;
}

class RenameColumnDto {
  @IsString() from!: string;
  @IsString() to!: string;
}

class AlterTableDto {
  @IsString() schema!: string;
  @IsString() name!: string;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => ColumnSpecDto) addColumns?: ColumnSpecDto[];
  @IsOptional() @IsArray() @IsString({ each: true }) dropColumns?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) dropConstraints?: string[];
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => RenameColumnDto) renameColumns?: RenameColumnDto[];
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => AlterColumnDto) alterColumns?: AlterColumnDto[];
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => ForeignKeySpecDto) addForeignKeys?: ForeignKeySpecDto[];
  @IsOptional() @IsString() renameTo?: string;
  @IsOptional() @IsBoolean() confirm?: boolean;
}

function meta(req: Request) { return { ip: req.ip, userAgent: req.get('user-agent') ?? undefined }; }

@Controller('connections/:id/schema/tables')
@UseGuards(RbacGuard)
export class SchemaController {
  constructor(private readonly svc: ConnectionsService, private readonly audit: AuditService) {}

  @Throttle({ heavy: { limit: 30, ttl: 60_000 } })
  @Post() @RequireRole('EDITOR')
  async create(
    @Param('id') id: string, @Body() dto: CreateTableDto,
    @CurrentUser() u: AuthUser, @Req() req: Request,
  ) {
    const role = (req as any).connectionRole as Role;
    if (role === Role.VIEWER) throw new BadRequestException('Read-only role');
    const spec: CreateTableSpec = { schema: dto.schema, name: dto.name, columns: dto.columns, foreignKeys: dto.foreignKeys };
    const drv = await this.svc.buildDriverForRole(id, role);
    try {
      const preview = await drv.createTable(spec, false);
      if (!dto.confirm) return { preview: preview.sql, executed: false };
      const done = await drv.createTable(spec, true);
      await this.audit.log({ userId: u.id, connectionId: id, action: 'SCHEMA_CHANGE', sqlText: done.sql, ...meta(req) });
      return { preview: done.sql, executed: true };
    } finally { await drv.close().catch(() => {}); }
  }

  @Throttle({ heavy: { limit: 30, ttl: 60_000 } })
  @Patch() @RequireRole('EDITOR')
  async alter(
    @Param('id') id: string, @Body() dto: AlterTableDto,
    @CurrentUser() u: AuthUser, @Req() req: Request,
  ) {
    const role = (req as any).connectionRole as Role;
    if (role === Role.VIEWER) throw new BadRequestException('Read-only role');
    const spec: AlterTableSpec = {
      schema: dto.schema, name: dto.name,
      addColumns: dto.addColumns, dropColumns: dto.dropColumns,
      dropConstraints: dto.dropConstraints,
      renameColumns: dto.renameColumns, alterColumns: dto.alterColumns,
      addForeignKeys: dto.addForeignKeys,
      renameTo: dto.renameTo,
    };
    const drv = await this.svc.buildDriverForRole(id, role);
    try {
      const preview = await drv.alterTable(spec, false);
      if (!dto.confirm) return { preview: preview.sql, executed: false };
      const done = await drv.alterTable(spec, true);
      await this.audit.log({ userId: u.id, connectionId: id, action: 'SCHEMA_CHANGE', sqlText: done.sql, ...meta(req) });
      return { preview: done.sql, executed: true };
    } finally { await drv.close().catch(() => {}); }
  }

  @Throttle({ heavy: { limit: 30, ttl: 60_000 } })
  @Delete() @RequireRole('OWNER')
  async drop(
    @Param('id') id: string,
    @Query('schema') schema: string,
    @Query('name') name: string,
    @Query('confirm') confirm: string | undefined,
    @CurrentUser() u: AuthUser, @Req() req: Request,
  ) {
    const role = (req as any).connectionRole as Role;
    const drv = await this.svc.buildDriverForRole(id, role);
    try {
      const preview = await drv.dropTable(schema, name, false);
      if (confirm !== 'true') return { preview: preview.sql, executed: false };
      const done = await drv.dropTable(schema, name, true);
      await this.audit.log({ userId: u.id, connectionId: id, action: 'SCHEMA_CHANGE', sqlText: done.sql, ...meta(req) });
      return { preview: done.sql, executed: true };
    } finally { await drv.close().catch(() => {}); }
  }
}
