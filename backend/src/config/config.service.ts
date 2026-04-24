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
  REDIS_URL: z.string().transform((v) => v || undefined).optional(),
  SCHEDULER_CONCURRENCY: z.coerce.number().int().positive().default(4),
  SCHEDULER_QUERY_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  SMTP_URL: z.string().transform((v) => v || undefined).optional(),
  SMTP_FROM: z.string().transform((v) => v || undefined).optional(),
  SLOW_QUERY_THRESHOLD_MS: z.coerce.number().int().positive().default(1000),
  SLOW_QUERY_RETENTION: z.coerce.number().int().positive().default(10_000),
  SENTRY_DSN: z.string().transform((v) => v || undefined).optional(),
  SENTRY_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0.2),
  API_KEY_RATE_LIMIT: z.coerce.number().int().positive().default(60),
  MAX_CONNECTIONS_PER_WORKSPACE: z.coerce.number().int().positive().default(50),
  MAX_SCHEDULED_QUERIES_PER_WORKSPACE: z.coerce.number().int().positive().default(50),
  MAX_WEBHOOKS_PER_CONNECTION: z.coerce.number().int().positive().default(20),
  // Where the user ends up after clicking a verification / password-reset
  // link. Must be a real browser origin (no trailing slash). Defaults to the
  // first allowed frontend origin.
  APP_BASE_URL: z.string().transform((v) => v || undefined).optional(),
  // When unset AND SMTP is unconfigured, signups auto-verify — otherwise the
  // operator would be locked out of their own self-hosted instance. Set to
  // `true` to force verification even without SMTP (useful for preview envs
  // where an operator will flip the DB flag manually).
  REQUIRE_EMAIL_VERIFICATION: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  // `pretty` is human-friendly for local dev; `json` emits one JSON object
  // per log line so Logtail/Datadog/Loki can parse without regex wrangling.
  LOG_FORMAT: z.enum(['pretty', 'json']).default('pretty'),
  // Key-management provider for envelope encryption. `local` uses the
  // ENCRYPTION_KEY env var as the master key (fine for self-host); the
  // others call out to a real KMS so the master key never sits on this host.
  KMS_PROVIDER: z.enum(['local', 'aws', 'gcp', 'vault']).default('local'),
  // Provider-specific config — all optional, only the relevant ones are read.
  AWS_KMS_KEY_ID: z.string().transform((v) => v || undefined).optional(),
  AWS_REGION: z.string().transform((v) => v || undefined).optional(),
  GCP_KMS_KEY_NAME: z.string().transform((v) => v || undefined).optional(),
  VAULT_ADDR: z.string().transform((v) => v || undefined).optional(),
  VAULT_TOKEN: z.string().transform((v) => v || undefined).optional(),
  VAULT_TRANSIT_KEY: z.string().transform((v) => v || undefined).optional(),
  // Bearer token Prometheus scrapers must present on /metrics. Leave unset
  // to disable the endpoint entirely (returns 404). Generate with:
  //   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
  METRICS_TOKEN: z.string().transform((v) => v || undefined).optional(),
  // Data retention (days). Older rows are pruned by the compliance sweep.
  RETENTION_AUDIT_DAYS: z.coerce.number().int().positive().default(365),
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
  get redisUrl() { return this.env.REDIS_URL; }
  get schedulerEnabled() { return !!this.env.REDIS_URL; }
  get schedulerConcurrency() { return this.env.SCHEDULER_CONCURRENCY; }
  get schedulerQueryTimeoutMs() { return this.env.SCHEDULER_QUERY_TIMEOUT_MS; }
  get smtpUrl() { return this.env.SMTP_URL; }
  get smtpFrom() { return this.env.SMTP_FROM; }
  get emailEnabled() { return !!(this.env.SMTP_URL && this.env.SMTP_FROM); }
  get slowQueryThresholdMs() { return this.env.SLOW_QUERY_THRESHOLD_MS; }
  get slowQueryRetention() { return this.env.SLOW_QUERY_RETENTION; }
  get sentryDsn() { return this.env.SENTRY_DSN; }
  get sentrySampleRate() { return this.env.SENTRY_SAMPLE_RATE; }
  get sentryEnabled() { return !!this.env.SENTRY_DSN; }
  get apiKeyRateLimit() { return this.env.API_KEY_RATE_LIMIT; }
  get maxConnectionsPerWorkspace() { return this.env.MAX_CONNECTIONS_PER_WORKSPACE; }
  get maxScheduledQueriesPerWorkspace() { return this.env.MAX_SCHEDULED_QUERIES_PER_WORKSPACE; }
  get maxWebhooksPerConnection() { return this.env.MAX_WEBHOOKS_PER_CONNECTION; }
  get appBaseUrl() {
    // Prefer explicit APP_BASE_URL, otherwise first FRONTEND_ORIGIN.
    return this.env.APP_BASE_URL ?? this.frontendOrigins[0] ?? 'http://localhost:5173';
  }
  get requireEmailVerification() {
    // If SMTP is configured we always require it; otherwise fall back to
    // the env flag so self-hosted single-user setups aren't forced to run
    // an SMTP server just to verify their own email.
    return this.env.REQUIRE_EMAIL_VERIFICATION || this.emailEnabled;
  }
  get logFormat() { return this.env.LOG_FORMAT; }
  get kmsProvider() { return this.env.KMS_PROVIDER; }
  get awsKmsKeyId() { return this.env.AWS_KMS_KEY_ID; }
  get awsRegion() { return this.env.AWS_REGION; }
  get gcpKmsKeyName() { return this.env.GCP_KMS_KEY_NAME; }
  get vaultAddr() { return this.env.VAULT_ADDR; }
  get vaultToken() { return this.env.VAULT_TOKEN; }
  get vaultTransitKey() { return this.env.VAULT_TRANSIT_KEY; }
  get metricsToken() { return this.env.METRICS_TOKEN; }
  get retentionAuditDays() { return this.env.RETENTION_AUDIT_DAYS; }
}
