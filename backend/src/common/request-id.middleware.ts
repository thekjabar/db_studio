import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Request, Response, NextFunction } from 'express';

/**
 * Attach a unique id to every request and echo it back on the response so
 * operators can correlate a user-reported issue with server logs. Accepts an
 * inbound `X-Request-Id` when present (e.g. from a load balancer) so traces
 * span multiple hops.
 */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const inbound = req.header('x-request-id');
    const id = inbound && /^[A-Za-z0-9_.:-]{1,128}$/.test(inbound) ? inbound : randomUUID();
    // Attach in both request + response so loggers and controllers can reach it.
    (req as unknown as { requestId: string }).requestId = id;
    res.setHeader('X-Request-Id', id);
    next();
  }
}
