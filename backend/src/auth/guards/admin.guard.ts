import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Allows only system admins (`User.isAdmin = true`) through.
 * Apply AFTER JwtAuthGuard so `req.user` is populated.
 *
 * We re-check the DB on every request rather than trusting a claim in the
 * JWT: admin promotion/demotion takes effect immediately, and a stolen
 * token can't grant admin if the user was demoted server-side.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const user = req.user as { id: string } | undefined;
    if (!user) throw new ForbiddenException();
    const row = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: { isAdmin: true },
    });
    if (!row?.isAdmin) throw new ForbiddenException('Admin access required');
    return true;
  }
}
