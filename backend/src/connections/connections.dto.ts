import {
  ArrayNotEmpty, IsArray, IsBoolean, IsEnum, IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString, Length, Max, Min,
  ValidateIf, ValidateNested, registerDecorator, type ValidationOptions,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { Dialect } from '@prisma/client';

/**
 * Each element must be a plain, non-null, non-array object — i.e. a row's
 * primary-key map like { id: "..." }. We use a hand-rolled validator instead of
 * `@IsObject({ each: true })` because the global ValidationPipe runs with
 * `enableImplicitConversion: true`, which makes per-element `@IsObject`
 * unreliable on a bare `Record[]` (no `@Type()` class to anchor it) and was
 * rejecting valid payloads with "each value in pks must be an object".
 */
function IsPlainObjectArray(opts?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isPlainObjectArray',
      target: object.constructor,
      propertyName,
      options: opts,
      validator: {
        validate(value: unknown) {
          return (
            Array.isArray(value) &&
            value.every((v) => v !== null && typeof v === 'object' && !Array.isArray(v))
          );
        },
        defaultMessage() {
          return `${propertyName} must be a non-empty array of objects`;
        },
      },
    });
  };
}

export class SshTunnelDto {
  @IsString() @Length(1, 253) host!: string;
  @IsInt() @Min(1) @Max(65535) port!: number;
  @IsString() @Length(1, 128) user!: string;
  @IsIn(['password', 'privateKey']) authType!: 'password' | 'privateKey';
  @IsOptional() @IsString() @Length(0, 1024) password?: string;
  // PEM-encoded private key body; can be large so upper bound is generous.
  @IsOptional() @IsString() @Length(0, 32_000) privateKey?: string;
  @IsOptional() @IsString() @Length(0, 1024) passphrase?: string;
}

export class CredentialsDto {
  @IsOptional() @IsString() @Length(1, 253) host?: string;
  @IsOptional() @IsInt() @Min(1) @Max(65535) port?: number;
  @IsOptional() @IsString() @Length(1, 128) user?: string;
  @IsOptional() @IsString() @Length(0, 256) password?: string;
  @IsOptional() @IsString() @Length(1, 128) database?: string;
  @IsOptional() @IsString() @Length(1, 1024) filename?: string;
  @IsOptional() @IsString() sslMode?: 'disable' | 'require' | 'verify-ca' | 'verify-full';
  // `ssh: null` means "remove the tunnel" on an update; skip nested validation in that case.
  @ValidateIf((_o, v) => v !== null && v !== undefined)
  @ValidateNested() @Type(() => SshTunnelDto)
  @IsOptional()
  ssh?: SshTunnelDto | null;
}

export class CreateConnectionDto {
  @IsString() @Length(1, 80) name!: string;
  @IsEnum(Dialect) dialect!: Dialect;
  @ValidateNested() @Type(() => CredentialsDto) credentials!: CredentialsDto;
  @IsOptional() @IsBoolean() readOnly?: boolean;
  @IsOptional() @IsInt() @Min(1000) @Max(600_000) statementTimeoutMs?: number;
  /** Workspace to create this connection under. Defaults to caller's personal workspace. */
  @IsOptional() @IsString() workspaceId?: string;
  /** Route this connection's DB traffic through a paired local agent. */
  @IsOptional() @IsBoolean() viaAgent?: boolean;
  @IsOptional() @IsString() agentId?: string | null;
}

export class UpdateConnectionDto {
  @IsOptional() @IsString() @Length(1, 80) name?: string;
  @IsOptional() @ValidateNested() @Type(() => CredentialsDto) credentials?: CredentialsDto;
  @IsOptional() @IsBoolean() readOnly?: boolean;
  @IsOptional() @IsInt() @Min(1000) @Max(600_000) statementTimeoutMs?: number;
  @IsOptional() @IsString() workspaceId?: string;
  @IsOptional() @IsInt() @Min(100) @Max(600_000) slowQueryAlertMs?: number | null;
  @IsOptional() @IsString() slowQueryAlertEmail?: string | null;
  @IsOptional() @IsBoolean() requireReview?: boolean;
  /** Route this connection's DB traffic through a paired local agent. */
  @IsOptional() @IsBoolean() viaAgent?: boolean;
  @IsOptional() @IsString() agentId?: string | null;
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
  // `@Transform(({ obj }) => obj.pks)` returns the ORIGINAL array untouched. The
  // global ValidationPipe runs with `enableImplicitConversion: true`, which — for
  // a field typed `Record<string, unknown>[]` (no `@Type()` class to anchor the
  // element type) — coerces every `{ id: "..." }` element into an empty array
  // `[]`, turning a valid `[{id}]` payload into `[[], []]` and failing validation
  // with "pks must be a non-empty array of objects". Reading straight from the
  // source object bypasses that per-element coercion.
  @IsArray() @ArrayNotEmpty() @IsPlainObjectArray()
  @Transform(({ obj }) => obj.pks)
  pks!: Record<string, unknown>[];
}

export class BulkUpdateRowsDto {
  @IsArray() @ArrayNotEmpty() @IsPlainObjectArray()
  @Transform(({ obj }) => obj.pks)
  pks!: Record<string, unknown>[];
  @IsObject() values!: Record<string, unknown>;
}

export class GenerateRowsDto {
  @IsString() schema!: string;
  @IsInt() @Min(1) @Max(1000) count!: number;
}
