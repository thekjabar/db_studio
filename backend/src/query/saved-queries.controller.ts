import {
  Body, Controller, Delete, Get, HttpCode, Param, Post, UseGuards,
} from '@nestjs/common';
import { IsString, Length } from 'class-validator';
import { SavedQueriesService } from './saved-queries.service';
import { RbacGuard } from '../rbac/rbac.guard';
import { RequireRole } from '../rbac/rbac.decorator';
import { CurrentUser, AuthUser } from '../auth/decorators/current-user.decorator';

class SavedQueryDto {
  @IsString() @Length(1, 80) name!: string;
  @IsString() @Length(1, 100_000) sqlText!: string;
}

@Controller('connections/:id/saved-queries')
@UseGuards(RbacGuard)
export class SavedQueriesController {
  constructor(private readonly svc: SavedQueriesService) {}

  @Get() @RequireRole('VIEWER')
  list(@Param('id') id: string) { return this.svc.list(id); }

  @Post() @RequireRole('EDITOR')
  create(@Param('id') id: string, @Body() dto: SavedQueryDto, @CurrentUser() u: AuthUser) {
    return this.svc.create(u.id, id, dto.name, dto.sqlText);
  }

  @Delete(':queryId') @RequireRole('EDITOR') @HttpCode(204)
  async remove(@Param('queryId') queryId: string, @CurrentUser() u: AuthUser) {
    await this.svc.remove(u.id, queryId);
  }
}
