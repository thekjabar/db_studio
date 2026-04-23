import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ArrayMinSize, IsArray, IsBoolean, IsEnum, IsOptional, IsString, IsUrl, Length, Matches } from 'class-validator';
import { WebhookEvent } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser, AuthUser } from '../auth/decorators/current-user.decorator';
import { WebhooksService } from './webhooks.service';

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export class CreateWebhookDto {
  @IsString() @Length(1, 80) name!: string;
  @IsString() @IsUrl({ require_protocol: true }) url!: string;
  @IsString() @Length(1, 64) @Matches(IDENT_RE) schemaName!: string;
  @IsString() @Length(1, 64) @Matches(IDENT_RE) tableName!: string;
  @IsArray() @ArrayMinSize(1) @IsEnum(WebhookEvent, { each: true }) events!: WebhookEvent[];
  @IsOptional() @IsBoolean() enabled?: boolean;
}

export class UpdateWebhookDto {
  @IsOptional() @IsString() @Length(1, 80) name?: string;
  @IsOptional() @IsString() @IsUrl({ require_protocol: true }) url?: string;
  @IsOptional() @IsString() @Length(1, 64) @Matches(IDENT_RE) schemaName?: string;
  @IsOptional() @IsString() @Length(1, 64) @Matches(IDENT_RE) tableName?: string;
  @IsOptional() @IsArray() @ArrayMinSize(1) @IsEnum(WebhookEvent, { each: true }) events?: WebhookEvent[];
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsString() @Length(16, 512) secret?: string;
}

@Controller('connections/:id/webhooks')
@UseGuards(JwtAuthGuard)
export class WebhooksController {
  constructor(private readonly svc: WebhooksService) {}

  @Get()
  list(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.list(u.id, id);
  }

  @Post()
  create(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
    @Body() dto: CreateWebhookDto,
  ) {
    return this.svc.create(u.id, id, dto);
  }

  @Get(':webhookId')
  get(@CurrentUser() u: AuthUser, @Param('webhookId') webhookId: string) {
    return this.svc.get(u.id, webhookId);
  }

  @Patch(':webhookId')
  update(
    @CurrentUser() u: AuthUser,
    @Param('webhookId') webhookId: string,
    @Body() dto: UpdateWebhookDto,
  ) {
    return this.svc.update(u.id, webhookId, dto);
  }

  @Delete(':webhookId')
  @HttpCode(204)
  async remove(@CurrentUser() u: AuthUser, @Param('webhookId') webhookId: string) {
    await this.svc.remove(u.id, webhookId);
  }

  @Post(':webhookId/test')
  test(@CurrentUser() u: AuthUser, @Param('webhookId') webhookId: string) {
    return this.svc.testFire(u.id, webhookId);
  }

  @Get(':webhookId/deliveries')
  deliveries(
    @CurrentUser() u: AuthUser,
    @Param('webhookId') webhookId: string,
    @Query('limit') limitRaw?: string,
  ) {
    const limit = limitRaw ? parseInt(limitRaw, 10) || 50 : 50;
    return this.svc.listDeliveries(u.id, webhookId, limit);
  }
}
