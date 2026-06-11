import 'reflect-metadata';
// Load .env BEFORE anything that reads process.env (Sentry init, config service).
// In Docker, env vars come from docker-compose; on the host this picks up
// backend/.env so `pnpm start:dev` works the same.
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import * as Sentry from '@sentry/node';
import { AppModule } from './app.module';
import { AppConfigService } from './config/config.service';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { makeLogger } from './common/json.logger';

async function bootstrap() {
  // Sentry must initialize BEFORE the Nest app is created so
  // unhandled errors during bootstrap also get reported. When no DSN is set
  // the SDK short-circuits every call, so this is safe to leave unconditional.
  const preConfig = {
    dsn: process.env.SENTRY_DSN,
    tracesSampleRate: process.env.SENTRY_SAMPLE_RATE ? Number(process.env.SENTRY_SAMPLE_RATE) : 0.2,
    environment: process.env.NODE_ENV ?? 'development',
  };
  if (preConfig.dsn) {
    Sentry.init(preConfig);
    Logger.log('Sentry enabled', 'Bootstrap');
  }

  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log'],
    bufferLogs: true,
  });

  const config = app.get(AppConfigService);
  // Swap in the JSON logger when the operator has opted in. The ConsoleLogger
  // is a better fit for local-dev (colorized + readable) so we leave that as
  // the bootstrap logger until we can read the env.
  app.useLogger(makeLogger(config.logFormat));

  // Helmet defaults are mostly fine; we tighten CSP explicitly. The API
  // serves JSON only — no HTML, no inline scripts — so a strict policy
  // catches any accidental reflected-HTML leak. The frontend (nginx)
  // container has its own CSP story.
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          defaultSrc: ["'none'"],
          baseUri: ["'none'"],
          frameAncestors: ["'none'"],
          formAction: ["'none'"],
          objectSrc: ["'none'"],
        },
      },
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
      // Allow the backup-stream endpoint to set Content-Disposition for
      // cross-origin downloads (already in CORS exposedHeaders).
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );
  app.use(cookieParser());

  // CORS accepts both customer origins (FRONTEND_ORIGIN) and operator
  // origins (OPERATOR_ORIGIN). Kept in one allow-list because splitting
  // CORS by URL path requires a custom middleware; instead we rely on
  // OperatorGuard to reject non-operator tokens on /api/operator/*.
  const allowedOrigins = [...config.frontendOrigins, ...config.operatorOrigins];
  app.enableCors({
    origin: allowedOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    exposedHeaders: [
      'Content-Disposition',
      'X-Dbdash-Estimate-Bytes',
      'X-Dbdash-Tables-Total',
    ],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  app.useGlobalFilters(new HttpExceptionFilter());

  app.setGlobalPrefix('api', { exclude: ['health'] });

  await app.listen(config.port);
  Logger.log(`Dbdash backend listening on :${config.port}`, 'Bootstrap');
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal bootstrap error', err);
  process.exit(1);
});
