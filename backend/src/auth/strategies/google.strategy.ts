import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, type Profile, type VerifyCallback } from 'passport-google-oauth20';
import { AppConfigService } from '../../config/config.service';

export interface OAuthProfilePayload {
  provider: 'google';
  providerId: string;
  email: string;
  displayName?: string;
}

@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, 'google') {
  constructor(cfg: AppConfigService) {
    // Pass dummy values when envs are missing so the passport base class
    // doesn't throw. The containing module never exposes this instance for
    // use in that case — registering the class is harmless.
    super({
      clientID: cfg.googleClientId ?? 'dbdash-sso-disabled',
      clientSecret: cfg.googleClientSecret ?? 'dbdash-sso-disabled',
      callbackURL: `${cfg.oauthCallbackBaseUrl}/api/auth/oauth/google/callback`,
      scope: ['email', 'profile'],
    });
  }

  validate(_at: string, _rt: string, profile: Profile, done: VerifyCallback): void {
    const email = profile.emails?.[0]?.value;
    if (!email) {
      done(new UnauthorizedException('Google account has no email'), undefined);
      return;
    }
    const payload: OAuthProfilePayload = {
      provider: 'google',
      providerId: profile.id,
      email,
      displayName: profile.displayName,
    };
    done(null, payload);
  }
}
