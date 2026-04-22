import { Module, Logger, type Provider } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { APP_GUARD } from '@nestjs/core';
import { AppConfigService } from '../config/config.service';
import { AuthController } from './auth.controller';
import { OAuthController } from './oauth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { GoogleStrategy } from './strategies/google.strategy';
import { GithubStrategy } from './strategies/github.strategy';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { GoogleOAuthGuard, GithubOAuthGuard } from './guards/oauth.guards';
import { AuditModule } from '../audit/audit.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';

// Strategies are only registered when their envs are set. Passport's OAuth2
// base class throws "requires a clientID option" at construction time if the
// id is falsy — there's no runtime-toggle available, so we have to avoid
// constructing the strategy at all when the provider isn't configured.
const googleStrategyProvider: Provider = {
  provide: GoogleStrategy,
  inject: [AppConfigService],
  useFactory: (cfg: AppConfigService) => {
    if (!cfg.googleOAuthEnabled) {
      new Logger('AuthModule').log('Google OAuth disabled (missing GOOGLE_CLIENT_ID/SECRET)');
      return null;
    }
    return new GoogleStrategy(cfg);
  },
};

const githubStrategyProvider: Provider = {
  provide: GithubStrategy,
  inject: [AppConfigService],
  useFactory: (cfg: AppConfigService) => {
    if (!cfg.githubOAuthEnabled) {
      new Logger('AuthModule').log('GitHub OAuth disabled (missing GITHUB_CLIENT_ID/SECRET)');
      return null;
    }
    return new GithubStrategy(cfg);
  },
};

@Module({
  imports: [
    PassportModule,
    JwtModule.registerAsync({
      inject: [AppConfigService],
      useFactory: (cfg: AppConfigService) => ({
        secret: cfg.jwtAccessSecret,
        signOptions: { expiresIn: cfg.jwtAccessTtl },
      }),
    }),
    AuditModule,
    WorkspacesModule,
  ],
  controllers: [AuthController, OAuthController],
  providers: [
    AuthService,
    JwtStrategy,
    googleStrategyProvider,
    githubStrategyProvider,
    GoogleOAuthGuard,
    GithubOAuthGuard,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
  exports: [AuthService, JwtModule],
})
export class AuthModule {}
