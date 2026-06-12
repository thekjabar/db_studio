import { Body, Controller, Delete, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import { SharedQueryService } from './shared-query.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser, type AuthUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';

class CreateShareDto {
  @IsString() @Length(1, 100000) sqlText!: string;
  @IsOptional() @IsString() @Length(1, 200) title?: string;
  @IsOptional() @IsInt() @Min(1) @Max(365) expiresInDays?: number;
  @IsOptional() @IsInt() @Min(1) @Max(10000) rowLimit?: number;
}

/** Owner-side: create / list / revoke shares for a connection. */
@Controller('connections/:id/shared-queries')
@UseGuards(JwtAuthGuard)
export class SharedQueryController {
  constructor(private readonly svc: SharedQueryService) {}

  @Get()
  list(@Param('id') connectionId: string, @CurrentUser() user: AuthUser) {
    return this.svc.listForConnection(user.id, connectionId);
  }

  @Post()
  @HttpCode(201)
  create(
    @Param('id') connectionId: string,
    @Body() dto: CreateShareDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.svc.create(user.id, { connectionId, ...dto });
  }

  @Delete(':shareId')
  revoke(@Param('shareId') shareId: string, @CurrentUser() user: AuthUser) {
    return this.svc.revoke(user.id, shareId);
  }
}

/** Public-side: no auth. Anyone with the token can view + re-run. */
@Controller('public/shared-queries')
export class PublicSharedQueryController {
  constructor(private readonly svc: SharedQueryService) {}

  @Public()
  @Get(':token')
  meta(@Param('token') token: string) {
    return this.svc.getPublicMeta(token);
  }

  @Public()
  @Post(':token/run')
  @HttpCode(200)
  run(@Param('token') token: string) {
    return this.svc.run(token);
  }
}
