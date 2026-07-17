import { Body, Controller, Delete, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { IsEmail, IsString, Length, Matches } from 'class-validator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RbacGuard } from '../rbac/rbac.guard';
import { RequireRole } from '../rbac/rbac.decorator';
import { CurrentUser, AuthUser } from '../auth/decorators/current-user.decorator';
import { ColumnMasksService } from './column-masks.service';

const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export class CreateColumnMaskDto {
  @IsEmail() email!: string;
  @IsString() @Length(1, 64) @Matches(IDENT) schemaName!: string;
  @IsString() @Length(1, 64) @Matches(IDENT) tableName!: string;
  @IsString() @Length(1, 64) @Matches(IDENT) columnName!: string;
}

@Controller('connections/:id/column-masks')
@UseGuards(JwtAuthGuard, RbacGuard)
export class ColumnMasksController {
  constructor(private readonly svc: ColumnMasksService) {}

  @Get() @RequireRole('OWNER')
  list(@Param('id') id: string) {
    return this.svc.list(id);
  }

  @Post()
  create(
    @Param('id') id: string,
    @CurrentUser() u: AuthUser,
    @Body() dto: CreateColumnMaskDto,
  ) {
    return this.svc.create(id, u.id, dto);
  }

  @Delete(':maskId')
  @HttpCode(204)
  async remove(
    @Param('id') id: string,
    @Param('maskId') maskId: string,
    @CurrentUser() u: AuthUser,
  ) {
    await this.svc.remove(id, u.id, maskId);
  }
}
