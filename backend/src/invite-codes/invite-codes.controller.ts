import { Body, Controller, Delete, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { IsEmail, IsInt, IsISO8601, IsOptional, IsString, Length, Min } from 'class-validator';
import { Public } from '../auth/decorators/public.decorator';
import { OperatorGuard, OperatorRequest } from '../operator/operator.guard';
import { InviteCodesService } from './invite-codes.service';

class CreateCodeDto {
  @IsOptional() @IsString() @Length(3, 64) code?: string;
  @IsOptional() @IsInt() @Min(0) maxUses?: number;
  @IsOptional() @IsISO8601() expiresAt?: string;
  @IsOptional() @IsEmail() assignedEmail?: string;
  @IsOptional() @IsString() note?: string;
}
class WaitlistAddDto {
  @IsEmail() email!: string;
}
class InviteEntryDto {
  @IsOptional() @IsInt() @Min(1) maxUses?: number;
}

@Public()
@Controller('waitlist')
export class WaitlistController {
  constructor(private readonly svc: InviteCodesService) {}
  @Post()
  add(@Body() dto: WaitlistAddDto) {
    return this.svc.addToWaitlist(dto.email);
  }
}

@Public()
@UseGuards(OperatorGuard)
@Controller('operator/invite-codes')
export class OperatorInviteCodesController {
  constructor(private readonly svc: InviteCodesService) {}

  @Get()
  list(@Query('limit') limitRaw = '50', @Query('offset') offsetRaw = '0') {
    const limit = Math.min(parseInt(limitRaw, 10) || 50, 200);
    const offset = Math.max(parseInt(offsetRaw, 10) || 0, 0);
    return this.svc.listCodes(limit, offset);
  }

  @Post()
  create(@Body() dto: CreateCodeDto, @Req() req: OperatorRequest) {
    return this.svc.createCode(req.operator!.id, {
      code: dto.code,
      maxUses: dto.maxUses,
      expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
      assignedEmail: dto.assignedEmail ?? null,
      note: dto.note ?? null,
    });
  }

  @Delete(':code')
  remove(@Param('code') code: string) {
    return this.svc.deleteCode(code);
  }
}

@Public()
@UseGuards(OperatorGuard)
@Controller('operator/waitlist')
export class OperatorWaitlistController {
  constructor(private readonly svc: InviteCodesService) {}

  @Get()
  list(@Query('limit') limitRaw = '100', @Query('offset') offsetRaw = '0') {
    const limit = Math.min(parseInt(limitRaw, 10) || 100, 500);
    const offset = Math.max(parseInt(offsetRaw, 10) || 0, 0);
    return this.svc.listWaitlist(limit, offset);
  }

  @Post(':id/invite')
  invite(@Param('id') id: string, @Body() dto: InviteEntryDto, @Req() req: OperatorRequest) {
    return this.svc.inviteWaitlistEntry(req.operator!.id, id, dto.maxUses ?? 1);
  }
}
