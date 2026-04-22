import { Controller, Get, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { AppConfigService } from '../config/config.service';
import { Public } from './decorators/public.decorator';
import { GoogleOAuthGuard, GithubOAuthGuard } from './guards/oauth.guards';
import type { OAuthProfilePayload } from './strategies/google.strategy';
import type { GithubOAuthProfilePayload } from './strategies/github.strategy';

const REFRESH_COOKIE = 'dbdash_rt';

type OAuthPayload = OAuthProfilePayload | GithubOAuthProfilePayload;

@Controller('auth/oauth')
export class OAuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly cfg: AppConfigService,
  ) {}

  private setRefreshCookie(res: Response, token: string, expires: Date) {
    res.cookie(REFRESH_COOKIE, token, {
      httpOnly: true,
      secure: this.cfg.cookieSecure,
      sameSite: 'lax', // lax so the cookie survives the cross-site redirect from Google/GitHub
      domain: this.cfg.cookieDomain,
      expires,
      path: '/api/auth',
    });
  }

  private meta(req: Request) {
    return { ip: req.ip, userAgent: req.get('user-agent') ?? undefined };
  }

  private frontendOrigin(): string {
    return this.cfg.frontendOrigins[0] ?? 'http://localhost:5173';
  }

  private async completeLogin(req: Request, res: Response) {
    const payload = req.user as OAuthPayload | undefined;
    const base = this.frontendOrigin();
    const successPath = this.cfg.oauthSuccessRedirect;
    if (!payload) {
      res.redirect(`${base}/login?error=oauth_failed`);
      return;
    }
    const t = await this.auth.loginOrCreateOAuth(payload, this.meta(req));
    this.setRefreshCookie(res, t.refreshToken, t.refreshExpiresAt);
    // Access token in URL fragment — never sent to the server, not logged.
    res.redirect(`${base}${successPath}#accessToken=${encodeURIComponent(t.accessToken)}`);
  }

  @Public()
  @UseGuards(GoogleOAuthGuard)
  @Get('google')
  googleStart(): void {
    // Guard redirects to Google.
  }

  @Public()
  @UseGuards(GoogleOAuthGuard)
  @Get('google/callback')
  async googleCallback(@Req() req: Request, @Res() res: Response) {
    await this.completeLogin(req, res);
  }

  @Public()
  @UseGuards(GithubOAuthGuard)
  @Get('github')
  githubStart(): void {
    // Guard redirects to GitHub.
  }

  @Public()
  @UseGuards(GithubOAuthGuard)
  @Get('github/callback')
  async githubCallback(@Req() req: Request, @Res() res: Response) {
    await this.completeLogin(req, res);
  }

  @Public()
  @Get('providers')
  providers() {
    return {
      google: this.cfg.googleOAuthEnabled,
      github: this.cfg.githubOAuthEnabled,
    };
  }
}
