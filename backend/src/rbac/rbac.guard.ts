import { BadRequestException, CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { RbacService } from './rbac.service';
import {
  REQUIRE_ROLE_KEY,
  REQUIRE_TABLE_ROLE_KEY,
  RoleName,
} from './rbac.decorator';

@Injectable()
export class RbacGuard implements CanActivate {
  constructor(private reflector: Reflector, private rbac: RbacService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const tableRequired = this.reflector.getAllAndOverride<RoleName>(REQUIRE_TABLE_ROLE_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    const connRequired = this.reflector.getAllAndOverride<RoleName>(REQUIRE_ROLE_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]) ?? 'VIEWER';

    const req = ctx.switchToHttp().getRequest();
    const user = req.user as { id: string } | undefined;
    if (!user) return false;
    const id = req.params?.id ?? req.params?.connectionId;
    if (!id) return false;

    if (tableRequired) {
      const tableName = req.params?.name ?? req.params?.table;
      const schemaName = req.query?.schema ?? req.body?.schema;
      if (!tableName || !schemaName) {
        throw new BadRequestException('Missing schema or table for RBAC check');
      }
      const role = await this.rbac.requireTable(
        user.id,
        id,
        String(schemaName),
        String(tableName),
        Role[tableRequired],
      );
      req.connectionRole = role;
      return true;
    }

    const role = await this.rbac.require(user.id, id, Role[connRequired]);
    req.connectionRole = role;
    return true;
  }
}
