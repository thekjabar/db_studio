import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { MetricsService } from './metrics.service';

/**
 * Records per-request HTTP latency + counters. Intentionally label-lean
 * (method + status class) to keep cardinality bounded — we do NOT label
 * by path because path params would explode the series count.
 */
@Injectable()
export class MetricsMiddleware implements NestMiddleware {
  constructor(private readonly metrics: MetricsService) {}

  use(req: Request, res: Response, next: NextFunction) {
    const started = Date.now();
    res.on('finish', () => {
      const ms = Date.now() - started;
      // `2xx`, `3xx`, `4xx`, `5xx` — 4 series per method instead of 500.
      const statusClass = `${Math.floor(res.statusCode / 100)}xx`;
      const labels = { method: req.method, status: statusClass };
      this.metrics.inc('dbstudio_http_requests_total', labels);
      this.metrics.observeMs('dbstudio_http_request_duration_ms', ms, labels);
    });
    next();
  }
}
