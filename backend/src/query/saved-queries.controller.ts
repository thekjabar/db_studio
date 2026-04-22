import {
  Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, UseGuards,
} from '@nestjs/common';
import { IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Length, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { SavedQueriesService } from './saved-queries.service';
import { RbacGuard } from '../rbac/rbac.guard';
import { RequireRole } from '../rbac/rbac.decorator';
import { CurrentUser, AuthUser } from '../auth/decorators/current-user.decorator';

class ChartConfigDto {
  @IsIn(['line', 'bar', 'pie', 'area']) type!: 'line' | 'bar' | 'pie' | 'area';
  @IsString() @Length(1, 128) x!: string;
  @IsArray() @IsString({ each: true }) y!: string[];
  @IsOptional() @IsBoolean() stacked?: boolean;
  @IsOptional() @IsInt() limit?: number;
}

class SavedQueryDto {
  @IsString() @Length(1, 80) name!: string;
  @IsString() @Length(1, 100_000) sqlText!: string;
  @IsOptional() @ValidateNested() @Type(() => ChartConfigDto) chartConfig?: ChartConfigDto;
}

class UpdateSavedQueryDto {
  @IsOptional() @IsString() @Length(1, 80) name?: string;
  @IsOptional() @IsString() @Length(1, 100_000) sqlText?: string;
  @IsOptional() @ValidateNested() @Type(() => ChartConfigDto) chartConfig?: ChartConfigDto | null;
}

@Controller('connections/:id/saved-queries')
@UseGuards(RbacGuard)
export class SavedQueriesController {
  constructor(private readonly svc: SavedQueriesService) {}

  @Get() @RequireRole('VIEWER')
  list(@Param('id') id: string) { return this.svc.list(id); }

  @Get(':queryId') @RequireRole('VIEWER')
  getOne(@Param('queryId') queryId: string) { return this.svc.get(queryId); }

  @Post() @RequireRole('EDITOR')
  create(@Param('id') id: string, @Body() dto: SavedQueryDto, @CurrentUser() u: AuthUser) {
    return this.svc.create(u.id, id, dto.name, dto.sqlText, dto.chartConfig ?? null);
  }

  @Patch(':queryId') @RequireRole('EDITOR')
  update(@Param('queryId') queryId: string, @Body() dto: UpdateSavedQueryDto, @CurrentUser() u: AuthUser) {
    return this.svc.update(u.id, queryId, dto);
  }

  @Delete(':queryId') @RequireRole('EDITOR') @HttpCode(204)
  async remove(@Param('queryId') queryId: string, @CurrentUser() u: AuthUser) {
    await this.svc.remove(u.id, queryId);
  }
}
