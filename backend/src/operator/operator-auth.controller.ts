import { Body, Controller, Get, Post, Req, Res, UseGuards, UnauthorizedException } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { IsEmail, IsString, MinLength } from 'class-validator';
import { OperatorAuthService } from './operator-auth.service';
import { OperatorGuard, OperatorRequest } from './operator.guard';
import { AppConfigService } from '../config/config.service';
import { Public } from '../auth/decorators/public.decorator';

class LoginDto {
  @IsEmail() email!: string;
  @IsString() @MinLength(1) password!: string;
}

/**
 * /api/operator/auth/* — login, refresh, logout, me. Mounted under the
 * same API prefix but strictly separated from the customer auth module.
 *
 * The @Public() marks these routes as exempt from the global customer
 * JwtAuthGuard. `me` uses OperatorGuard explicitly so it still requires
 * an operator JWT — they're just different auth universes.
 */
@Public()
@Controller('operator/auth')
export class OperatorAuthController {
  constructor(
    private readonly svc: OperatorAuthService,
    private readonly cfg: AppConfigService,
  ) {}

  private cookieOpts(secureOverride?: boolean) {
    return {
      httpOnly: true,
      sameSite: 'lax' as const,
      secure: secureOverride ?? this.cfg.cookieSecure,
      path: '/',
    };
  }

  private meta(req: Request) {
    return {
      ip: (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip,
      userAgent: req.get('user-agent') ?? undefined,
    };
  }

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('login')
  async login(@Body() dto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { accessToken, refreshToken, refreshExpiresAt, operator } = await this.svc.login(
      dto.email,
      dto.password,
      this.meta(req),
    );
    res.cookie('operator_access', accessToken, { ...this.cookieOpts(), maxAge: 30 * 60 * 1000 });
    res.cookie('operator_refresh', refreshToken, {
      ...this.cookieOpts(),
      expires: refreshExpiresAt,
    });
    return { operator, accessToken };
  }

  @Post('refresh')
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = (req as Request & { cookies?: Record<string, string> }).cookies?.operator_refresh;
    if (!token) throw new UnauthorizedException('No refresh cookie');
    const { accessToken, refreshToken, refreshExpiresAt } = await this.svc.refresh(token, this.meta(req));
    res.cookie('operator_access', accessToken, { ...this.cookieOpts(), maxAge: 30 * 60 * 1000 });
    res.cookie('operator_refresh', refreshToken, {
      ...this.cookieOpts(),
      expires: refreshExpiresAt,
    });
    return { accessToken };
  }

  @Post('logout')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = (req as Request & { cookies?: Record<string, string> }).cookies?.operator_refresh;
    await this.svc.logout(token);
    res.clearCookie('operator_access', this.cookieOpts());
    res.clearCookie('operator_refresh', this.cookieOpts());
    return { ok: true as const };
  }

  @UseGuards(OperatorGuard)
  @Get('me')
  async me(@Req() req: OperatorRequest) {
    return this.svc.me(req.operator!.id);
  }
}
