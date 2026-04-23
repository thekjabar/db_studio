import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { AppConfigService } from './config/config.service';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log'],
    bufferLogs: true,
  });

  const config = app.get(AppConfigService);

  app.use(helmet());
  app.use(cookieParser());

  app.enableCors({
    origin: config.frontendOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    // Make custom response headers readable from the browser. Without this,
    // fetch/xhr silently strip anything outside the CORS-safelisted set —
    // which breaks the backup progress UI (it reads the estimate + filename
    // from headers set by the streaming response).
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
