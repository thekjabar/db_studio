import { SetMetadata } from '@nestjs/common';
import { Role } from '@prisma/client';

export const REQUIRE_ROLE_KEY = 'requireRole';
export type RoleName = keyof typeof Role;

/** Minimum role required to invoke the handler. */
export const RequireRole = (role: RoleName) => SetMetadata(REQUIRE_ROLE_KEY, role);
