import {
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { Response } from 'express';
import { PinoLogger } from 'nestjs-pino';
import { type Observable, of } from 'rxjs';
import { pathOf, type GatewayRequest } from '../common/gateway-request.js';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import {
  type CachePlan,
  pickStoredHeaders,
  planCache,
  storeVerdict,
} from './cache-plan.js';
import { type CacheEntry, CacheService } from './cache.service.js';
import { captureResponse } from './capture.js';

export type CacheStatus = 'HIT' | 'MISS' | 'BYPASS';

/**
 * Step 5 of the lifecycle (docs/02 §3, docs/05 §2): serve GET/HEAD from Redis when a fresh entry
 * exists, otherwise let the proxy run and tee its response into the cache when it qualifies.
 * Runs after the guards, so cached responses are still authenticated and (by default) rate limited.
 */
@Injectable()
export class CacheInterceptor implements NestInterceptor {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly cache: CacheService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(CacheInterceptor.name);
  }

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const req = context.switchToHttp().getRequest<GatewayRequest>();
    const res = context.switchToHttp().getResponse<Response>();
    const route = req.gw?.route;
    if (!route) return next.handle();

    const url = req.originalUrl ?? req.url;
    const q = url.indexOf('?');
    const plan = planCache(
      {
        method: req.method,
        path: pathOf(url),
        query: q === -1 ? '' : url.slice(q),
        headers: req.headers,
      },
      route,
      req.principal,
      this.env,
    );
    if (plan.mode === 'skip') return next.handle();

    let holdsLock = false;
    if (plan.mode === 'lookup') {
      const hit = await this.cache.get(plan.key);
      if (hit) return this.serve(res, req.method, hit, 'HIT');

      holdsLock = await this.cache.acquireLock(plan.key);
      if (!holdsLock) {
        const late = await this.cache.waitForEntry(plan.key);
        if (late) return this.serve(res, req.method, late, 'HIT');
      }
    }

    const status: CacheStatus = plan.mode === 'bypass' ? 'BYPASS' : 'MISS';
    res.setHeader('X-Cache', status);
    res.locals.cache_status = status;
    captureResponse(res, this.env.CACHE_MAX_BODY_BYTES, (captured) => {
      void this.afterResponse(
        plan,
        captured.status,
        captured.headers,
        captured.body,
        holdsLock,
      );
    });
    return next.handle();
  }

  private async afterResponse(
    plan: CachePlan,
    status: number,
    headers: import('node:http').OutgoingHttpHeaders,
    body: Buffer | null,
    holdsLock: boolean,
  ): Promise<void> {
    try {
      const verdict = storeVerdict(
        status,
        headers,
        body?.length ?? null,
        this.env.CACHE_MAX_BODY_BYTES,
      );
      if (verdict.ok && body) {
        await this.cache.store(plan.key, plan.indexKey, plan.ttlSeconds, {
          status,
          headers: pickStoredHeaders(headers),
          bodyB64: body.toString('base64'),
          storedAt: Date.now(),
        });
      } else {
        this.logger.debug(
          { key: plan.key, reason: verdict.ok ? 'no body' : verdict.reason },
          'response not cached',
        );
      }
    } finally {
      if (holdsLock) await this.cache.releaseLock(plan.key);
    }
  }

  private serve(
    res: Response,
    method: string,
    entry: CacheEntry,
    status: CacheStatus,
  ): Observable<undefined> {
    const body = Buffer.from(entry.bodyB64, 'base64');
    res.status(entry.status);
    for (const [name, value] of Object.entries(entry.headers))
      res.setHeader(name, value);
    res.setHeader('X-Cache', status);
    res.setHeader(
      'Age',
      String(Math.max(0, Math.floor((Date.now() - entry.storedAt) / 1000))),
    );
    res.locals.cache_status = status;
    if (entry.status === 204 || entry.status === 304) {
      res.end();
    } else {
      res.setHeader('Content-Length', String(body.length));
      if (method.toUpperCase() === 'HEAD') res.end();
      else res.end(body);
    }
    return of(undefined);
  }
}
