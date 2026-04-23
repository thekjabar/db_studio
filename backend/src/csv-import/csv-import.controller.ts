import {
  Body,
  Controller,
  Delete,
  HttpCode,
  Param,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { ArrayNotEmpty, IsArray, IsBoolean, IsInt, IsOptional, IsString, Length, Matches, Min, ValidateIf, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser, AuthUser } from '../auth/decorators/current-user.decorator';
import { RbacGuard } from '../rbac/rbac.guard';
import { RequireRole } from '../rbac/rbac.decorator';
import { CsvImportService } from './csv-import.service';

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export class MappingDto {
  @ValidateIf((_o, v) => v !== null)
  @IsInt() @Min(0)
  csvColumn!: number | null;

  @IsString() @Length(1, 64) @Matches(IDENT_RE)
  targetColumn!: string;
}

export class DryRunDto {
  @IsString() @Length(1, 64) @Matches(IDENT_RE) schema!: string;
  @IsString() @Length(1, 64) @Matches(IDENT_RE) table!: string;
  @IsArray() @ArrayNotEmpty() @ValidateNested({ each: true }) @Type(() => MappingDto)
  mappings!: MappingDto[];
}

export class CommitDto extends DryRunDto {
  @IsOptional() @IsBoolean() stopOnError?: boolean;
}

@Controller('connections/:id/csv-import')
@UseGuards(JwtAuthGuard, RbacGuard)
export class CsvImportController {
  constructor(private readonly svc: CsvImportService) {}

  @Throttle({ heavy: { limit: 10, ttl: 60_000 } })
  @Post('upload')
  @RequireRole('EDITOR')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 50 * 1024 * 1024 } }))
  async upload(
    @Param('id') id: string,
    @CurrentUser() u: AuthUser,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) throw new Error('file is required');
    return this.svc.upload(u.id, id, file.originalname, file.buffer);
  }

  @Post(':sessionId/dry-run')
  @RequireRole('EDITOR')
  dryRun(
    @CurrentUser() u: AuthUser,
    @Param('sessionId') sessionId: string,
    @Body() dto: DryRunDto,
  ) {
    return this.svc.dryRun(u.id, sessionId, dto.schema, dto.table, dto.mappings);
  }

  @Throttle({ heavy: { limit: 5, ttl: 60_000 } })
  @Post(':sessionId/commit')
  @RequireRole('EDITOR')
  commit(
    @CurrentUser() u: AuthUser,
    @Param('sessionId') sessionId: string,
    @Body() dto: CommitDto,
  ) {
    return this.svc.commit(u.id, sessionId, dto.schema, dto.table, dto.mappings, {
      stopOnError: dto.stopOnError,
    });
  }

  @Delete(':sessionId')
  @HttpCode(204)
  @RequireRole('VIEWER')
  async discard(@CurrentUser() u: AuthUser, @Param('sessionId') sessionId: string) {
    await this.svc.discard(u.id, sessionId);
  }
}
