import { Controller, Delete, Get, HttpCode, Param, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { createHash } from 'crypto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { CurrentUser, AuthUser } from './decorators/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';

const REFRESH_COOKIE = 'dbdash_rt';

/**
 * User-facing session management. Lists the caller's own active refresh
 * tokens — one per device/browser — with enough metadata to recognize
 * them (userAgent, IP, last used). Revoking a session = marking its
 * refresh token revoked, which invalidates that browser on next refresh.
 */
@Controller('auth/sessions')
@UseGuards(JwtAuthGuard)
export class SessionsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(@CurrentUser() user: AuthUser, @Req() req: Request) {
    const rows = await this.prisma.refreshToken.findMany({
      where: { userId: user.id, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        userAgent: true,
        ip: true,
        createdAt: true,
        expiresAt: true,
      },
    });

    // Mark which session is "this one" so the UI can warn before revoking.
    // We hash the cookie's raw token the same way AuthService does and look
    // for a match.
    const raw = (req.cookies ?? {})[REFRESH_COOKIE] as string | undefined;
    const currentHash = raw ? createHash('sha256').update(raw).digest('hex') : null;
    const mine = currentHash
      ? await this.prisma.refreshToken.findUnique({
          where: { tokenHash: currentHash },
          select: { id: true },
        })
      : null;

    return rows.map((r) => ({
      id: r.id,
      userAgent: r.userAgent,
      ip: r.ip,
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
      current: mine?.id === r.id,
    }));
  }

  @Delete(':id')
  @HttpCode(200)
  async revoke(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const existing = await this.prisma.refreshToken.findUnique({ where: { id } });
    if (!existing || existing.userId !== user.id) {
      // Don't leak presence of other users' tokens.
      return { ok: true as const };
    }
    await this.prisma.refreshToken.update({
      where: { id },
      data: { revokedAt: new Date() },
    });
    return { ok: true as const };
  }

  /** Revoke every session except the one making this request. Handy for
   *  "log out everywhere else" after a suspected compromise. */
  @Delete()
  @HttpCode(200)
  async revokeAllOthers(@CurrentUser() user: AuthUser, @Req() req: Request) {
    const raw = (req.cookies ?? {})[REFRESH_COOKIE] as string | undefined;
    const keepHash = raw ? createHash('sha256').update(raw).digest('hex') : null;
    const res = await this.prisma.refreshToken.updateMany({
      where: {
        userId: user.id,
        revokedAt: null,
        ...(keepHash ? { NOT: { tokenHash: keepHash } } : {}),
      },
      data: { revokedAt: new Date() },
    });
    return { revoked: res.count };
  }
}
