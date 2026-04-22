import {
  Body,
  Controller,
  HttpCode,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { Public } from './decorators/public.decorator';
import { CurrentUser, AuthUser } from './decorators/current-user.decorator';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { AppConfigService } from '../config/config.service';
import {
  SignupDto,
  LoginDto,
  EnableTotpDto,
  DisableTotpDto,
} from './dto/auth.dto';

const REFRESH_COOKIE = 'dbdash_rt';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly cfg: AppConfigService,
  ) {}

  private setRefreshCookie(res: Response, token: string, expires: Date) {
    res.cookie(REFRESH_COOKIE, token, {
      httpOnly: true,
      secure: this.cfg.cookieSecure,
      sameSite: 'strict',
      domain: this.cfg.cookieDomain,
      expires,
      path: '/api/auth',
    });
  }

  private clearRefreshCookie(res: Response) {
    res.clearCookie(REFRESH_COOKIE, {
      httpOnly: true,
      secure: this.cfg.cookieSecure,
      sameSite: 'strict',
      domain: this.cfg.cookieDomain,
      path: '/api/auth',
    });
  }

  private meta(req: Request) {
    return {
      ip: req.ip,
      userAgent: req.get('user-agent') ?? undefined,
    };
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('signup')
  async signup(@Body() dto: SignupDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const t = await this.auth.signup(dto, this.meta(req));
    this.setRefreshCookie(res, t.refreshToken, t.refreshExpiresAt);
    return { accessToken: t.accessToken, userId: t.userId };
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  @Post('login')
  async login(@Body() dto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const t = await this.auth.login(dto, this.meta(req));
    this.setRefreshCookie(res, t.refreshToken, t.refreshExpiresAt);
    return { accessToken: t.accessToken, userId: t.userId };
  }

  @Public()
  @HttpCode(200)
  @Post('refresh')
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const raw = (req.cookies ?? {})[REFRESH_COOKIE];
    if (!raw) throw new UnauthorizedException('Missing refresh token');
    const t = await this.auth.refresh(raw, this.meta(req));
    this.setRefreshCookie(res, t.refreshToken, t.refreshExpiresAt);
    return { accessToken: t.accessToken };
  }

  @UseGuards(JwtAuthGuard)
  @HttpCode(204)
  @Post('logout')
  async logout(
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const raw = (req.cookies ?? {})[REFRESH_COOKIE];
    await this.auth.logout(raw, user.id, this.meta(req));
    this.clearRefreshCookie(res);
  }

  @UseGuards(JwtAuthGuard)
  @Post('2fa/enable')
  async enable2fa(@CurrentUser() user: AuthUser) {
    return this.auth.startTotpEnrollment(user.id);
  }

  @UseGuards(JwtAuthGuard)
  @HttpCode(204)
  @Post('2fa/verify')
  async verify2fa(
    @CurrentUser() user: AuthUser,
    @Body() dto: EnableTotpDto,
    @Req() req: Request,
  ) {
    await this.auth.confirmTotp(user.id, dto, this.meta(req));
  }

  @UseGuards(JwtAuthGuard)
  @HttpCode(204)
  @Post('2fa/disable')
  async disable2fa(
    @CurrentUser() user: AuthUser,
    @Body() dto: DisableTotpDto,
    @Req() req: Request,
  ) {
    await this.auth.disableTotp(user.id, dto, this.meta(req));
  }
}
