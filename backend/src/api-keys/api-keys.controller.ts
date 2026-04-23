import { Body, Controller, Delete, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { IsArray, IsDateString, IsOptional, IsString, Length } from 'class-validator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser, AuthUser } from '../auth/decorators/current-user.decorator';
import { ApiKeysService } from './api-keys.service';

export class CreateApiKeyDto {
  @IsString() @Length(1, 80) name!: string;
  @IsOptional() @IsArray() @IsString({ each: true }) connectionIds?: string[];
  @IsOptional() @IsDateString() expiresAt?: string;
}

@Controller('api-keys')
@UseGuards(JwtAuthGuard)
export class ApiKeysController {
  constructor(private readonly svc: ApiKeysService) {}

  @Get()
  list(@CurrentUser() u: AuthUser) {
    return this.svc.list(u.id);
  }

  @Post()
  create(@CurrentUser() u: AuthUser, @Body() dto: CreateApiKeyDto) {
    return this.svc.create(u.id, {
      name: dto.name,
      connectionIds: dto.connectionIds,
      expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
    });
  }

  @Post(':id/revoke')
  revoke(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.revoke(u.id, id);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    await this.svc.remove(u.id, id);
  }
}
