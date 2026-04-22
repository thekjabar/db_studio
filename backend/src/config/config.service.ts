import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url(),
  FRONTEND_ORIGIN: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be >=32 chars'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be >=32 chars'),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('7d'),
  ENCRYPTION_KEY: z.string().min(1, 'ENCRYPTION_KEY is required'),
  COOKIE_DOMAIN: z.string().default('localhost'),
  COOKIE_SECURE: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  DEFAULT_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  RATE_LIMIT_TTL_SEC: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
  RATE_LIMIT_LOGIN_MAX: z.coerce.number().int().positive().default(10),
  TOTP_ISSUER: z.string().default('Dbdash'),
  // Empty strings (from `docker compose ${FOO:-}`) are normalized to undefined
  // so `??` fallbacks kick in downstream.
  ANTHROPIC_API_KEY: z.string().transform((v) => v || undefined).optional(),
  ANTHROPIC_MODEL: z.string().default('claude-haiku-4-5-20251001'),
  GOOGLE_CLIENT_ID: z.string().transform((v) => v || undefined).optional(),
  GOOGLE_CLIENT_SECRET: z.string().transform((v) => v || undefined).optional(),
  GITHUB_CLIENT_ID: z.string().transform((v) => v || undefined).optional(),
  GITHUB_CLIENT_SECRET: z.string().transform((v) => v || undefined).optional(),
  OAUTH_CALLBACK_BASE_URL: z.string().transform((v) => v || undefined).optional(),
  OAUTH_SUCCESS_REDIRECT: z.string().default('/auth/callback'),
});

export type AppEnv = z.infer<typeof EnvSchema>;

@Injectable()
export class AppConfigService {
  private readonly env: AppEnv;
  private readonly logger = new Logger(AppConfigService.name);
  readonly encryptionKey: Buffer;

  constructor() {
    const parsed = EnvSchema.safeParse(process.env);
    if (!parsed.success) {
      // eslint-disable-next-line no-console
      console.error('Invalid environment:', parsed.error.flatten().fieldErrors);
      throw new Error('Invalid environment configuration');
    }
    this.env = parsed.data;

    // Decode & validate encryption key: must be exactly 32 bytes.
    const keyBuf = Buffer.from(this.env.ENCRYPTION_KEY, 'base64');
    if (keyBuf.length !== 32) {
      throw new Error(
        `ENCRYPTION_KEY must decode to 32 bytes (got ${keyBuf.length}). ` +
          `Generate: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`,
      );
    }
    this.encryptionKey = keyBuf;
    this.logger.log(`Config loaded (env=${this.env.NODE_ENV})`);
  }

  get nodeEnv() { return this.env.NODE_ENV; }
  get isProd() { return this.env.NODE_ENV === 'production'; }
  get port() { return this.env.PORT; }
  get databaseUrl() { return this.env.DATABASE_URL; }
  get frontendOrigins(): string[] {
    return this.env.FRONTEND_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean);
  }
  get jwtAccessSecret() { return this.env.JWT_ACCESS_SECRET; }
  get jwtRefreshSecret() { return this.env.JWT_REFRESH_SECRET; }
  get jwtAccessTtl() { return this.env.JWT_ACCESS_TTL; }
  get jwtRefreshTtl() { return this.env.JWT_REFRESH_TTL; }
  get cookieDomain() { return this.env.COOKIE_DOMAIN; }
  get cookieSecure() { return this.env.COOKIE_SECURE; }
  get defaultStatementTimeoutMs() { return this.env.DEFAULT_STATEMENT_TIMEOUT_MS; }
  get rateLimitTtlSec() { return this.env.RATE_LIMIT_TTL_SEC; }
  get rateLimitMax() { return this.env.RATE_LIMIT_MAX; }
  get rateLimitLoginMax() { return this.env.RATE_LIMIT_LOGIN_MAX; }
  get totpIssuer() { return this.env.TOTP_ISSUER; }
  get anthropicApiKey() { return this.env.ANTHROPIC_API_KEY; }
  get anthropicModel() { return this.env.ANTHROPIC_MODEL; }
  get aiEnabled() { return !!this.env.ANTHROPIC_API_KEY; }
  get googleClientId() { return this.env.GOOGLE_CLIENT_ID; }
  get googleClientSecret() { return this.env.GOOGLE_CLIENT_SECRET; }
  get githubClientId() { return this.env.GITHUB_CLIENT_ID; }
  get githubClientSecret() { return this.env.GITHUB_CLIENT_SECRET; }
  get oauthCallbackBaseUrl() {
    return this.env.OAUTH_CALLBACK_BASE_URL ?? `http://localhost:${this.env.PORT}`;
  }
  get oauthSuccessRedirect() { return this.env.OAUTH_SUCCESS_REDIRECT; }
  get googleOAuthEnabled() {
    return !!(this.env.GOOGLE_CLIENT_ID && this.env.GOOGLE_CLIENT_SECRET);
  }
  get githubOAuthEnabled() {
    return !!(this.env.GITHUB_CLIENT_ID && this.env.GITHUB_CLIENT_SECRET);
  }
}
