import { Body, Controller, Delete, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { IsEnum, IsOptional, IsString, Length } from 'class-validator';
import { IncidentSeverity, IncidentStatus } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AdminGuard } from '../auth/guards/admin.guard';
import { CurrentUser, AuthUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { SkipThrottle } from '@nestjs/throttler';
import { StatusService } from './status.service';

class CreateIncidentDto {
  @IsString() @Length(1, 200) title!: string;
  @IsOptional() @IsEnum(IncidentSeverity) severity?: IncidentSeverity;
  @IsOptional() @IsString() @Length(0, 500) impact?: string;
  @IsString() @Length(1, 2000) message!: string;
}

class AddUpdateDto {
  @IsEnum(IncidentStatus) status!: IncidentStatus;
  @IsString() @Length(1, 2000) message!: string;
}

// Public status page — no auth. Skip throttling so the status page itself
// doesn't contribute to rate-limit pressure when load-balancer health
// checks or kubernetes liveness probes hit it.
@Controller('status')
@SkipThrottle()
export class PublicStatusController {
  constructor(private readonly svc: StatusService) {}

  @Public()
  @Get()
  get() {
    return this.svc.publicStatus();
  }
}

// Admin-only CRUD for incidents.
@Controller('admin/incidents')
@UseGuards(JwtAuthGuard, AdminGuard)
export class IncidentsAdminController {
  constructor(private readonly svc: StatusService) {}

  @Get()
  list() {
    return this.svc.list();
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateIncidentDto) {
    return this.svc.create(user.id, dto);
  }

  @Post(':id/updates')
  @HttpCode(200)
  addUpdate(@Param('id') id: string, @Body() dto: AddUpdateDto) {
    return this.svc.addUpdate(id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id') id: string) {
    await this.svc.remove(id);
  }
}
