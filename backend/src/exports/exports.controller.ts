import { Body, Controller, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { IsIn, IsOptional, IsString, Length } from 'class-validator';
import { Role } from '@prisma/client';
import { RbacGuard } from '../rbac/rbac.guard';
import { RequireRole } from '../rbac/rbac.decorator';
import { CurrentUser, AuthUser } from '../auth/decorators/current-user.decorator';
import { ExportsService, ExportTarget } from './exports.service';

class ExportDto {
  @IsString() @Length(1, 100_000) sql!: string;
  @IsIn(['email', 'slack', 'webhook']) target!: ExportTarget;
  @IsString() @Length(1, 2_000) to!: string;
  @IsOptional() @IsString() @Length(1, 200) name?: string;
}

function meta(req: Request) {
  return { ip: req.ip, userAgent: req.get('user-agent') ?? undefined };
}

@Controller('connections/:id/export')
@UseGuards(RbacGuard)
export class ExportsController {
  constructor(private readonly svc: ExportsService) {}

  // Lower throttle than /query — sending email/slack externally is expensive
  // and fan-out-worthy, so 10/min per caller is the ceiling.
  @Throttle({ heavy: { limit: 10, ttl: 60_000 } })
  @Post()
  @HttpCode(200)
  @RequireRole('VIEWER')
  async run(
    @Param('id') id: string,
    @Body() dto: ExportDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    const role = (req as any).connectionRole as Role;
    return this.svc.run(
      user.id,
      role,
      { connectionId: id, sql: dto.sql, target: dto.target, to: dto.to, name: dto.name },
      meta(req),
    );
  }
}
