import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, type Profile } from 'passport-github2';
import { AppConfigService } from '../../config/config.service';

export interface GithubOAuthProfilePayload {
  provider: 'github';
  providerId: string;
  email: string;
  displayName?: string;
}

type VerifyDone = (err: Error | null, user?: GithubOAuthProfilePayload) => void;

@Injectable()
export class GithubStrategy extends PassportStrategy(Strategy, 'github') {
  constructor(cfg: AppConfigService) {
    super({
      clientID: cfg.githubClientId ?? 'dbdash-sso-disabled',
      clientSecret: cfg.githubClientSecret ?? 'dbdash-sso-disabled',
      callbackURL: `${cfg.oauthCallbackBaseUrl}/api/auth/oauth/github/callback`,
      scope: ['user:email'],
    });
  }

  validate(_at: string, _rt: string, profile: Profile, done: VerifyDone): void {
    // GitHub may return multiple emails; pick the primary verified one, else first.
    const emails = profile.emails ?? [];
    const primary = emails.find((e) => (e as { primary?: boolean }).primary);
    const email = (primary ?? emails[0])?.value;
    if (!email) {
      done(new UnauthorizedException('GitHub account has no public email — enable email in profile'));
      return;
    }
    done(null, {
      provider: 'github',
      providerId: profile.id,
      email,
      displayName: profile.displayName ?? profile.username,
    });
  }
}
