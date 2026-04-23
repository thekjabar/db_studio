import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import * as Sentry from '@sentry/node';
import { Request, Response } from 'express';

/**
 * Global exception filter that sanitizes responses so that stack traces, raw
 * SQL errors, and credentials NEVER leak to clients.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('HttpExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let safeMessage: string | string[] = 'Internal server error';
    let code = 'INTERNAL_ERROR';

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const resp = exception.getResponse();
      if (typeof resp === 'string') {
        safeMessage = resp;
      } else if (typeof resp === 'object' && resp !== null) {
        const r = resp as Record<string, unknown>;
        safeMessage = (r.message as string) ?? exception.message;
        code = (r.error as string) ?? code;
      }
    } else if (exception instanceof Error) {
      this.logger.error(`Unhandled ${exception.name}: ${exception.message}`, exception.stack);
      // Only send non-HTTP (i.e. unexpected) errors to Sentry; HttpExceptions
      // are part of normal API contract and would drown the inbox.
      Sentry.captureException(exception, {
        tags: {
          path: req.url,
          method: req.method,
          requestId: (req as unknown as { requestId?: string }).requestId,
        },
      });
    } else {
      this.logger.error('Unknown exception', String(exception));
    }

    const requestId = (req as unknown as { requestId?: string }).requestId;
    res.status(status).json({
      statusCode: status,
      code,
      message: safeMessage,
      path: req.url,
      requestId,
      timestamp: new Date().toISOString(),
    });
  }
}
