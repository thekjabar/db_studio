import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsOptional, IsString, Length, Matches, Max, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser, AuthUser } from '../auth/decorators/current-user.decorator';
import { FederatedService } from './federated.service';

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export class FederatedSourceDto {
  @IsString() @Length(1, 64) @Matches(IDENT_RE) alias!: string;
  @IsString() @Length(1, 64) connectionId!: string;
}

export class FederatedQueryDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(5)
  @ValidateNested({ each: true }) @Type(() => FederatedSourceDto)
  sources!: FederatedSourceDto[];
  @IsString() @Length(1, 100_000) sql!: string;
  @IsOptional() @IsInt() @Min(0) @Max(100_000) maxRows?: number;
}

@Controller('federated')
@UseGuards(JwtAuthGuard)
export class FederatedController {
  constructor(private readonly svc: FederatedService) {}

  @Throttle({ heavy: { limit: 10, ttl: 60_000 } })
  @Post('query')
  @HttpCode(200)
  query(@CurrentUser() u: AuthUser, @Body() dto: FederatedQueryDto) {
    return this.svc.runQuery(u.id, dto.sources, dto.sql, dto.maxRows ?? 1000);
  }
}
