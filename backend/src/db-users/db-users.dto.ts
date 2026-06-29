import {
  IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Length, Max, Min,
} from 'class-validator';

/** Postgres role name: same shape we allow for identifiers (1-63 chars). */
export class CreateDbUserDto {
  @IsString() @Length(1, 63) name!: string;
  // Password is optional — a NOLOGIN group role doesn't need one.
  @IsOptional() @IsString() @Length(1, 256) password?: string;
  @IsOptional() @IsBoolean() login?: boolean;       // can the role log in (default true)
  @IsOptional() @IsBoolean() superuser?: boolean;
  @IsOptional() @IsBoolean() createDb?: boolean;
  @IsOptional() @IsBoolean() createRole?: boolean;
  @IsOptional() @IsBoolean() inherit?: boolean;
  // BYPASSRLS: the role ignores row-level security policies (sees all rows).
  // Essential for admin/operator users on Supabase DBs where RLS is on.
  @IsOptional() @IsBoolean() bypassRls?: boolean;
  @IsOptional() @IsInt() @Min(1) @Max(100000) connectionLimit?: number;
  // ISO date string; role login expires after this instant.
  @IsOptional() @IsString() @Length(1, 40) validUntil?: string;
}

export class AlterDbUserDto {
  @IsOptional() @IsString() @Length(1, 256) password?: string;
  @IsOptional() @IsBoolean() login?: boolean;
  @IsOptional() @IsBoolean() superuser?: boolean;
  @IsOptional() @IsBoolean() createDb?: boolean;
  @IsOptional() @IsBoolean() createRole?: boolean;
  @IsOptional() @IsBoolean() bypassRls?: boolean;
  @IsOptional() @IsInt() @Min(-1) @Max(100000) connectionLimit?: number;
  @IsOptional() @IsString() @Length(0, 40) validUntil?: string; // empty string clears it
}

export const PRIVILEGE_LEVELS = ['database', 'schema', 'table'] as const;
export type PrivilegeLevel = (typeof PRIVILEGE_LEVELS)[number];

// Privileges valid for at least one level; we validate per-level in the service.
export const ALL_PRIVILEGES = [
  'ALL', 'CONNECT', 'CREATE', 'TEMPORARY', 'USAGE',
  'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER',
] as const;

export class GrantDto {
  @IsString() @Length(1, 63) role!: string;
  @IsIn(PRIVILEGE_LEVELS) level!: PrivilegeLevel;
  @IsArray() @IsString({ each: true }) privileges!: string[];
  // schema is required for schema/table level; ignored for database level.
  @IsOptional() @IsString() @Length(1, 63) schema?: string;
  // table is required for table level.
  @IsOptional() @IsString() @Length(1, 63) table?: string;
  // WITH GRANT OPTION (the role may re-grant what it was granted).
  @IsOptional() @IsBoolean() withGrantOption?: boolean;
}

export class RevokeDto extends GrantDto {}

/** Add or remove role membership (GRANT role TO member). */
export class MembershipDto {
  @IsString() @Length(1, 63) parentRole!: string;  // the group/role being granted
  @IsString() @Length(1, 63) memberRole!: string;  // the role receiving membership
}
