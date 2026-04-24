import { Body, Controller, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsOptional, IsString, Length } from 'class-validator';
import { AiService } from './ai.service';
import { RbacGuard } from '../rbac/rbac.guard';
import { RequireRole } from '../rbac/rbac.decorator';
import { CurrentUser, AuthUser } from '../auth/decorators/current-user.decorator';

class GenerateSqlDto {
  @IsString() @Length(1, 4_000) prompt!: string;
  @IsOptional() @IsString() schema?: string;
}

@Controller('connections/:id/ai')
@UseGuards(RbacGuard)
export class AiController {
  constructor(private readonly ai: AiService) {}

  @Throttle({ heavy: { limit: 20, ttl: 60_000 } })
  @Post('generate-sql')
  @HttpCode(200)
  @RequireRole('VIEWER')
  async generate(
    @Param('id') connectionId: string,
    @Body() dto: GenerateSqlDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.ai.generateSql({ userId: user.id, connectionId, prompt: dto.prompt, schema: dto.schema });
  }
}
