import { SetMetadata } from '@nestjs/common';
import { Role } from '@prisma/client';

export const REQUIRE_ROLE_KEY = 'requireRole';
export const REQUIRE_TABLE_ROLE_KEY = 'requireTableRole';
export type RoleName = keyof typeof Role;

/** Minimum role required to invoke the handler. */
export const RequireRole = (role: RoleName) => SetMetadata(REQUIRE_ROLE_KEY, role);

/**
 * Minimum role required at the specific (schema, table) targeted by this request.
 * Resolves schema from `@Query('schema')` and table from `@Param('name')`.
 * Falls back to connection-level role if no per-table grant exists.
 */
export const RequireTableRole = (role: RoleName) =>
  SetMetadata(REQUIRE_TABLE_ROLE_KEY, role);
