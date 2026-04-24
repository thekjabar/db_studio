import { Body, Controller, Delete, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { IsEmail, IsString, Length, Matches } from 'class-validator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser, AuthUser } from '../auth/decorators/current-user.decorator';
import { RowFiltersService } from './row-filters.service';

const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export class UpsertRowFilterDto {
  @IsEmail() email!: string;
  @IsString() @Length(1, 64) @Matches(IDENT) schemaName!: string;
  @IsString() @Length(1, 64) @Matches(IDENT) tableName!: string;
  // predicate is validated by the service's grammar, not via regex here.
  @IsString() @Length(1, 1000) predicate!: string;
}

@Controller('connections/:id/row-filters')
@UseGuards(JwtAuthGuard)
export class RowFiltersController {
  constructor(private readonly svc: RowFiltersService) {}

  @Get()
  list(@Param('id') id: string) {
    return this.svc.list(id);
  }

  @Post()
  upsert(
    @Param('id') id: string,
    @CurrentUser() u: AuthUser,
    @Body() dto: UpsertRowFilterDto,
  ) {
    return this.svc.upsert(id, u.id, dto);
  }

  @Delete(':filterId')
  @HttpCode(204)
  async remove(
    @Param('id') id: string,
    @Param('filterId') filterId: string,
    @CurrentUser() u: AuthUser,
  ) {
    await this.svc.remove(id, u.id, filterId);
  }
}
