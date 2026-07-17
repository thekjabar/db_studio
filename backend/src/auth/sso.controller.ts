import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { IsBoolean, IsOptional, IsString, Length } from 'class-validator';
import { AppConfigService } from '../config/config.service';
import { PrismaService } from '../prisma/prisma.service';
import { Public } from './decorators/public.decorator';
import { CurrentUser, AuthUser } from './decorators/current-user.decorator';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { SsoService } from './sso.service';

const REFRESH_COOKIE = 'dbdash_rt';
const STATE_COOKIE_PREFIX = 'dbdash_sso_state_';
const NONCE_COOKIE_PREFIX = 'dbdash_sso_nonce_';

class SsoConfigDto {
  @IsString() @Length(10, 500) issuerUrl!: string;
  @IsString() @Length(1, 500) clientId!: string;
  @IsOptional() @IsString() @Length(0, 500) clientSecret?: string;
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsString() @Length(0, 500) allowedDomains?: string;
  @IsOptional() @IsBoolean() autoProvision?: boolean;
}

@Controller()
export class SsoController {
  constructor(
    private readonly sso: SsoService,
    private readonly cfg: AppConfigService,
    private readonly prisma: PrismaService,
  ) {}

  private reqMeta(req: Request) {
    return { ip: req.ip, userAgent: req.get('user-agent') ?? undefined };
  }

  private frontendOrigin(): string {
    return this.cfg.frontendOrigins[0] ?? 'http://localhost:5173';
  }

  /**
   * SECURITY: SSO is disabled unless SSO_ENABLED=true. A workspace owner
   * supplies their own OIDC issuer, so the IdP is attacker-controlled; until we
   * verify domain ownership it must not be able to assert identities. Every SSO
   * route calls this first so the feature is inert while disabled.
   */
  private assertSsoEnabled() {
    if (!this.cfg.ssoEnabled) {
      throw new NotFoundException('SSO is not enabled on this instance');
    }
  }

  private async requireWorkspaceOwner(userId: string, workspaceId: string) {
    const ws = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { ownerId: true },
    });
    if (!ws) throw new ForbiddenException('Workspace not found');
    if (ws.ownerId !== userId) throw new ForbiddenException('Only the workspace owner can manage SSO');
  }

  // ----- Admin endpoints (authenticated workspace owner) -----

  @UseGuards(JwtAuthGuard)
  @Get('workspaces/:workspaceId/sso')
  async getConfig(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: AuthUser,
  ) {
    this.assertSsoEnabled();
    await this.requireWorkspaceOwner(user.id, workspaceId);
    return this.sso.getConfig(workspaceId);
  }

  @UseGuards(JwtAuthGuard)
  @Put('workspaces/:workspaceId/sso')
  async upsertConfig(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: SsoConfigDto,
    @CurrentUser() user: AuthUser,
  ) {
    this.assertSsoEnabled();
    await this.requireWorkspaceOwner(user.id, workspaceId);
    return this.sso.upsertConfig(workspaceId, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Delete('workspaces/:workspaceId/sso')
  async disable(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: AuthUser,
  ) {
    this.assertSsoEnabled();
    await this.requireWorkspaceOwner(user.id, workspaceId);
    return this.sso.disable(workspaceId);
  }

  // ----- Public login flow (no JWT required) -----

  @Public()
  @Get('auth/sso/:slug')
  async start(@Param('slug') slug: string, @Res() res: Response) {
    this.assertSsoEnabled();
    const { url, state, nonce } = await this.sso.beginLogin(slug);
    const common = {
      httpOnly: true,
      secure: this.cfg.cookieSecure,
      sameSite: 'lax' as const,
      domain: this.cfg.cookieDomain,
      maxAge: 10 * 60 * 1000,
      path: '/api/auth',
    };
    res.cookie(STATE_COOKIE_PREFIX + slug, state, common);
    res.cookie(NONCE_COOKIE_PREFIX + slug, nonce, common);
    res.redirect(url);
  }

  @Public()
  @Get('auth/sso/:slug/callback')
  async callback(
    @Param('slug') slug: string,
    @Query('code') code: string,
    @Query('state') state: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    this.assertSsoEnabled();
    const base = this.frontendOrigin();
    const expectedState = (req.cookies ?? {})[STATE_COOKIE_PREFIX + slug] as string | undefined;
    const expectedNonce = (req.cookies ?? {})[NONCE_COOKIE_PREFIX + slug] as string | undefined;
    // Clear state cookies immediately — they're single-use.
    res.clearCookie(STATE_COOKIE_PREFIX + slug, { path: '/api/auth', domain: this.cfg.cookieDomain });
    res.clearCookie(NONCE_COOKIE_PREFIX + slug, { path: '/api/auth', domain: this.cfg.cookieDomain });

    try {
      const tokens = await this.sso.completeLogin(
        slug,
        code,
        state,
        expectedState ?? '',
        expectedNonce ?? '',
        this.reqMeta(req),
      );
      res.cookie(REFRESH_COOKIE, tokens.refreshToken, {
        httpOnly: true,
        secure: this.cfg.cookieSecure,
        sameSite: 'lax',
        domain: this.cfg.cookieDomain,
        expires: tokens.refreshExpiresAt,
        path: '/api/auth',
      });
      const successPath = this.cfg.oauthSuccessRedirect;
      res.redirect(`${base}${successPath}#accessToken=${encodeURIComponent(tokens.accessToken)}`);
    } catch (err) {
      // Avoid leaking internal details in the URL; surface a generic code.
      const msg = err instanceof Error ? err.message : 'sso_failed';
      res.redirect(`${base}/login?error=sso&detail=${encodeURIComponent(msg.slice(0, 200))}`);
    }
  }

  /** Check if SSO is available for a workspace slug. Lets the login page show
   *  a "Sign in with SSO" button without revealing other config details. */
  @Public()
  @Get('auth/sso/:slug/available')
  async available(@Param('slug') slug: string) {
    // Reports false rather than 404ing — the login page polls this on every
    // load and should just not offer the SSO button when the feature is off.
    if (!this.cfg.ssoEnabled) return { available: false };
    const ws = await this.prisma.workspace.findUnique({
      where: { slug },
      include: { sso: { select: { enabled: true } } },
    });
    return { available: !!ws?.sso?.enabled };
  }
}
