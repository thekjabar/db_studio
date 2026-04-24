import { Body, Controller, Delete, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { IsOptional, IsString, Length } from 'class-validator';
import { Public } from '../auth/decorators/public.decorator';
import { OperatorGuard, OperatorRequest } from '../operator/operator.guard';
import { AbuseService } from './abuse.service';

class BlockIpDto {
  @IsString() @Length(3, 64) ip!: string;
  @IsOptional() @IsString() reason?: string;
}

@Public()
@UseGuards(OperatorGuard)
@Controller('operator/abuse')
export class OperatorAbuseController {
  constructor(private readonly svc: AbuseService) {}

  @Get()
  list(
    @Query('acked') ackedRaw?: string,
    @Query('rule') rule?: string,
    @Query('ip') ip?: string,
    @Query('limit') limitRaw = '100',
    @Query('offset') offsetRaw = '0',
  ) {
    const limit = Math.min(parseInt(limitRaw, 10) || 100, 500);
    const offset = Math.max(parseInt(offsetRaw, 10) || 0, 0);
    const acked = ackedRaw === 'true' ? true : ackedRaw === 'false' ? false : undefined;
    return this.svc.list({ acked, rule, ip, limit, offset });
  }

  @Post(':id/ack')
  ack(@Param('id') id: string, @Req() req: OperatorRequest) {
    return this.svc.ack(req.operator!.id, id);
  }

  @Post('ack-ip/:ip')
  ackIp(@Param('ip') ip: string, @Req() req: OperatorRequest) {
    return this.svc.ackByIp(req.operator!.id, ip);
  }

  @Get('blocked-ips')
  blocked() {
    return this.svc.listBlockedIps();
  }

  @Post('block-ip')
  block(@Body() dto: BlockIpDto, @Req() req: OperatorRequest) {
    return this.svc.blockIp(req.operator!.id, dto.ip, dto.reason);
  }

  @Delete('block-ip/:ip')
  unblock(@Param('ip') ip: string) {
    return this.svc.unblockIp(ip);
  }
}
