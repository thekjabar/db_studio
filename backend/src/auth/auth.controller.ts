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
import { IsEmail, IsString, Length } from 'class-validator';
import { Transform } from 'class-transformer';
import type { Request, Response } from 'express';

/** Normalize email so case/whitespace variants resolve to one account. */
const normalizeEmail = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;
import { AuthService } from './auth.service';
import { EmailVerificationService } from './email-verification.service';
import { PasswordResetService } from './password-reset.service';
import { Public } from './decorators/public.decorator';
import { CurrentUser, AuthUser } from './decorators/current-user.decorator';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { AppConfigService } from '../config/config.service';
import {
  SignupDto,
  LoginDto,
  EnableTotpDto,
  DisableTotpDto,
  ChangePasswordDto,
} from './dto/auth.dto';

class VerifyEmailDto {
  @IsString() @Length(1, 512) token!: string;
}
class ResendVerificationDto {
  @Transform(normalizeEmail) @IsEmail() email!: string;
}
class RequestPasswordResetDto {
  @Transform(normalizeEmail) @IsEmail() email!: string;
}
class CompletePasswordResetDto {
  @IsString() @Length(1, 512) token!: string;
  @IsString() @Length(8, 256) newPassword!: string;
}

const REFRESH_COOKIE = 'dbdash_rt';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly verification: EmailVerificationService,
    private readonly passwordReset: PasswordResetService,
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
    if ('needsVerification' in t) {
      // No session cookie — user must click the email link first.
      return { userId: t.userId, needsVerification: true };
    }
    if ('awaitingApproval' in t) {
      // No session cookie — operator must approve before the user can log in.
      return { userId: t.userId, awaitingApproval: true };
    }
    this.setRefreshCookie(res, t.refreshToken, t.refreshExpiresAt);
    return { accessToken: t.accessToken, userId: t.userId };
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  @Post('verify-email')
  async verifyEmail(@Body() dto: VerifyEmailDto) {
    await this.verification.verify(dto.token);
    return { ok: true };
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(200)
  @Post('resend-verification')
  async resendVerification(@Body() dto: ResendVerificationDto) {
    // Always 200 — don't disclose which emails exist.
    await this.verification.requestResend(dto.email);
    return { ok: true };
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(200)
  @Post('request-password-reset')
  async requestPasswordReset(@Body() dto: RequestPasswordResetDto) {
    await this.passwordReset.requestReset(dto.email);
    // Same 200 regardless of whether the email exists.
    return { ok: true };
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  @Post('complete-password-reset')
  async completePasswordReset(@Body() dto: CompletePasswordResetDto) {
    await this.passwordReset.completeReset(dto.token, dto.newPassword);
    return { ok: true };
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
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(204)
  @Post('change-password')
  async changePassword(
    @CurrentUser() user: AuthUser,
    @Body() dto: ChangePasswordDto,
    @Req() req: Request,
  ) {
    const currentRefresh = (req.cookies ?? {})[REFRESH_COOKIE];
    await this.auth.changePassword(user.id, dto, this.meta(req), currentRefresh);
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
