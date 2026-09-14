import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { Problems } from '../common/problem/problem.js';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';

/**
 * `/metrics` describes traffic shape, error rates and how close the anomaly stage is to firing, so
 * it is not public.
 *
 * Set `METRICS_TOKEN` and scrape with a bearer token. Leave it unset and the endpoint serves in
 * development and refuses in production, because an unauthenticated metrics endpoint on a public URL
 * is a disclosure rather than a convenience, and a default that is safe only when someone remembers
 * to change it is not a safe default.
 */
@Injectable()
export class MetricsGuard implements CanActivate {
  constructor(@Inject(ENV) private readonly env: Env) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const expected = this.env.METRICS_TOKEN;

    if (!expected) {
      if (this.env.NODE_ENV === 'production')
        throw Problems.notFound(`Cannot GET ${req.originalUrl}`);
      return true;
    }

    const header = req.headers.authorization ?? '';
    const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
    const a = Buffer.from(presented);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b))
      throw Problems.unauthorized('Invalid metrics token');
    return true;
  }
}
