import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import type { GatewayRequest } from '../common/gateway-request.js';
import { MetricsService } from './metrics.service.js';

/**
 * Records one request on the way out, reading what the rest of the pipeline already put on
 * res.locals. Nothing is computed twice and nothing is added to the hot path beyond a few map
 * lookups after the response has been sent.
 */
@Injectable()
export class MetricsMiddleware implements NestMiddleware {
  constructor(private readonly metrics: MetricsService) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const startedAt = process.hrtime.bigint();

    res.once('finish', () => {
      const locals = res.locals as {
        rate_limited?: boolean;
        cache_status?: string;
        anomaly_blocked?: boolean;
        upstream_ms?: number;
      };
      // The resolved service name, or a fixed label. Never the path: a raw path is unbounded
      // cardinality and will eventually take the process down.
      const route = (req as GatewayRequest).gw?.route.service ?? 'unrouted';
      const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;

      this.metrics.increment(
        'omnigate_requests_total',
        {
          route,
          method: req.method,
          status: `${Math.floor(res.statusCode / 100)}xx`,
        },
        'Requests handled by the gateway.',
      );
      this.metrics.observe(
        'omnigate_request_duration_seconds',
        seconds,
        { route },
        'Gateway to client latency, including time waiting on the upstream.',
      );
      if (typeof locals.upstream_ms === 'number')
        this.metrics.observe(
          'omnigate_upstream_duration_seconds',
          locals.upstream_ms / 1000,
          { route },
          'Time waiting on the upstream alone.',
        );
      if (locals.rate_limited)
        this.metrics.increment(
          'omnigate_rate_limited_total',
          { route },
          'Requests refused by the rate limiter.',
        );
      if (locals.cache_status)
        this.metrics.increment(
          'omnigate_cache_total',
          { route, status: locals.cache_status },
          'Cache outcomes on cacheable reads.',
        );
      if (locals.anomaly_blocked)
        this.metrics.increment(
          'omnigate_anomaly_blocked_total',
          { route },
          'Requests refused by anomaly enforcement.',
        );
    });

    next();
  }
}
