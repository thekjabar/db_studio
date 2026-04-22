import {
  ArrayNotEmpty, IsArray, IsBoolean, IsEnum, IsInt, IsNumber, IsObject, IsOptional, IsString, Length, Max, Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { Dialect } from '@prisma/client';

export class CredentialsDto {
  @IsOptional() @IsString() @Length(1, 253) host?: string;
  @IsOptional() @IsInt() @Min(1) @Max(65535) port?: number;
  @IsOptional() @IsString() @Length(1, 128) user?: string;
  @IsOptional() @IsString() @Length(0, 256) password?: string;
  @IsOptional() @IsString() @Length(1, 128) database?: string;
  @IsOptional() @IsString() @Length(1, 1024) filename?: string;
  @IsOptional() @IsString() sslMode?: 'disable' | 'require' | 'verify-ca' | 'verify-full';
}

export class CreateConnectionDto {
  @IsString() @Length(1, 80) name!: string;
  @IsEnum(Dialect) dialect!: Dialect;
  @ValidateNested() @Type(() => CredentialsDto) credentials!: CredentialsDto;
  @IsOptional() @IsBoolean() readOnly?: boolean;
  @IsOptional() @IsInt() @Min(1000) @Max(600_000) statementTimeoutMs?: number;
  /** Workspace to create this connection under. Defaults to caller's personal workspace. */
  @IsOptional() @IsString() workspaceId?: string;
}

export class UpdateConnectionDto {
  @IsOptional() @IsString() @Length(1, 80) name?: string;
  @IsOptional() @ValidateNested() @Type(() => CredentialsDto) credentials?: CredentialsDto;
  @IsOptional() @IsBoolean() readOnly?: boolean;
  @IsOptional() @IsInt() @Min(1000) @Max(600_000) statementTimeoutMs?: number;
  @IsOptional() @IsString() workspaceId?: string;
}

export class TableDataFilterDto {
  @IsString() column!: string;
  @IsString() op!: string;
  value?: unknown;
}

export class TableDataQueryDto {
  @IsOptional() @IsNumber() limit?: number;
  @IsOptional() @IsNumber() offset?: number;
  @IsOptional() @IsString() orderBy?: string; // "col:asc,col2:desc"
  @IsOptional() @IsString() filters?: string; // JSON string
}

export class InsertRowDto {
  @IsObject() values!: Record<string, unknown>;
}
export class UpdateRowDto {
  @IsObject() pk!: Record<string, unknown>;
  @IsObject() values!: Record<string, unknown>;
}
export class DeleteRowDto {
  @IsObject() pk!: Record<string, unknown>;
}

export class BulkDeleteRowsDto {
  @IsArray() @ArrayNotEmpty() @IsObject({ each: true })
  pks!: Record<string, unknown>[];
}

export class BulkUpdateRowsDto {
  @IsArray() @ArrayNotEmpty() @IsObject({ each: true })
  pks!: Record<string, unknown>[];
  @IsObject() values!: Record<string, unknown>;
}
