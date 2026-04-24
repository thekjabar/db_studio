import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { IsEmail, IsOptional, IsString, Length } from 'class-validator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser, AuthUser } from '../auth/decorators/current-user.decorator';
import { SchemaDocsService } from './schema-docs.service';

class UpsertDocDto {
  @IsString() @Length(1, 64) schemaName!: string;
  @IsString() @Length(1, 64) tableName!: string;
  @IsOptional() @IsString() @Length(0, 64) columnName?: string;
  @IsOptional() @IsString() @Length(0, 10_000) description?: string;
  @IsOptional() @IsString() @Length(0, 500) tags?: string;
  @IsOptional() @IsEmail() ownerEmail?: string;
}

@Controller('connections/:id/schema-docs')
@UseGuards(JwtAuthGuard)
export class SchemaDocsController {
  constructor(private readonly svc: SchemaDocsService) {}

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Query('schema') schemaName?: string,
    @Query('table') tableName?: string,
  ) {
    return this.svc.list(user.id, id, schemaName, tableName);
  }

  @Post()
  @HttpCode(200)
  upsert(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpsertDocDto) {
    return this.svc.upsert(user.id, id, dto);
  }

  @Delete(':docId')
  remove(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('docId') docId: string,
  ) {
    return this.svc.remove(user.id, id, docId);
  }
}
