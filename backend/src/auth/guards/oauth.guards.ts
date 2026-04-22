import { ExecutionContext, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { AppConfigService } from '../../config/config.service';

@Injectable()
export class GoogleOAuthGuard extends AuthGuard('google') {
  constructor(private readonly cfg: AppConfigService) {
    super();
  }
  canActivate(ctx: ExecutionContext) {
    if (!this.cfg.googleOAuthEnabled) {
      throw new ServiceUnavailableException('Google SSO not configured');
    }
    return super.canActivate(ctx);
  }
}

@Injectable()
export class GithubOAuthGuard extends AuthGuard('github') {
  constructor(private readonly cfg: AppConfigService) {
    super();
  }
  canActivate(ctx: ExecutionContext) {
    if (!this.cfg.githubOAuthEnabled) {
      throw new ServiceUnavailableException('GitHub SSO not configured');
    }
    return super.canActivate(ctx);
  }
}
