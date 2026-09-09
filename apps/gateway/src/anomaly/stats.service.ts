import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { RedisService } from '../redis/redis.service.js';
import { HEURISTIC_THRESHOLDS } from './anomaly.config.js';

const MINUTE_MS = 60_000;
/** Per-minute buckets kept a little longer than the 10 m window they feed. */
const BUCKET_TTL_S = 11 * 60;
const ROUTE_BODY_TTL_S = 24 * 3600;

export interface RequestStats {
  burstCount10s: number;
  distinctPaths60s: number;
  authFailures60s: number;
  routeBody: { n: number; mean: number; std: number } | null;
}

export interface PrincipalStats10m {
  requests: number;
  errorRate: number;
  distinctPaths: number;
}

const minuteBucket = (now: number, offset = 0): number =>
  Math.floor(now / MINUTE_MS) - offset;
const pathsKey = (principal: string, bucket: number): string =>
  `astat:paths:${principal}:${bucket}`;
const authFailKey = (ip: string, bucket: number): string =>
  `astat:authfail:${ip}:${bucket}`;
const principalKey = (principal: string, bucket: number): string =>
  `astat:p:${principal}:${bucket}`;
const routeBodyKey = (route: string): string => `astat:route:${route}`;

/**
 * Redis-backed short-term statistics behind the behavioural signals (docs/08 S5-03, docs/06 §4).
 * One pipeline per request; every failure degrades to zeros through RedisService.safe().
 */
@Injectable()
export class AnomalyStatsService {
  constructor(
    private readonly redis: RedisService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(AnomalyStatsService.name);
  }

  /** Record this request and read back what the scorer needs, in a single round trip. */
  async recordAndRead(input: {
    principal: string;
    clientIp: string;
    route: string;
    path: string;
    bodyBytes: number;
    rateLimitKey: string;
    now?: number;
  }): Promise<RequestStats> {
    const now = input.now ?? Date.now();
    const cur = minuteBucket(now);
    const prev = minuteBucket(now, 1);
    const empty: RequestStats = {
      burstCount10s: 0,
      distinctPaths60s: 0,
      authFailures60s: 0,
      routeBody: null,
    };

    return this.redis.safe(
      'anomaly stats',
      async (c) => {
        const p = c.pipeline();
        const withBody = input.bodyBytes > 0;
        if (withBody) {
          const rk = routeBodyKey(input.route);
          p.hincrbyfloat(rk, 'n', 1)
            .hincrbyfloat(rk, 'sum', input.bodyBytes)
            .hincrbyfloat(rk, 'sumsq', input.bodyBytes * input.bodyBytes)
            .expire(rk, ROUTE_BODY_TTL_S);
        }
        p.zcount(
          input.rateLimitKey,
          now - HEURISTIC_THRESHOLDS.burstWindowMs,
          now,
        );
        p.pfadd(pathsKey(input.principal, cur), input.path)
          .pfcount(
            pathsKey(input.principal, cur),
            pathsKey(input.principal, prev),
          )
          .expire(pathsKey(input.principal, cur), BUCKET_TTL_S);
        p.get(authFailKey(input.clientIp, cur)).get(
          authFailKey(input.clientIp, prev),
        );
        p.hincrby(principalKey(input.principal, cur), 'requests', 1).expire(
          principalKey(input.principal, cur),
          BUCKET_TTL_S,
        );
        const results = (await p.exec()) ?? [];
        const values = results.map(([err, v]) => (err ? null : v));
        let i = 0;
        let routeBody: RequestStats['routeBody'] = null;
        if (withBody) {
          const n = Number(values[i++]);
          const sum = Number(values[i++]);
          const sumsq = Number(values[i++]);
          i++; // expire
          if (n > 0) {
            const mean = sum / n;
            const variance = Math.max(0, sumsq / n - mean * mean);
            routeBody = { n, mean, std: Math.sqrt(variance) };
          }
        }
        const burstCount10s = Number(values[i++] ?? 0);
        i++; // pfadd
        const distinctPaths60s = Number(values[i++] ?? 0);
        i++; // expire
        const authFailures60s =
          Number(values[i++] ?? 0) + Number(values[i++] ?? 0);
        return { burstCount10s, distinctPaths60s, authFailures60s, routeBody };
      },
      empty,
    );
  }

  /** Called by the AuthGuard when presented credentials are rejected (feeds auth_failures, T2). */
  recordAuthFailure(clientIp: string, now = Date.now()): void {
    const key = authFailKey(clientIp, minuteBucket(now));
    void this.redis.safe(
      'auth failure counter',
      async (c) => {
        await c.multi().incr(key).expire(key, 120).exec();
      },
      undefined,
    );
  }

  /** Called when a screened request finishes with a 4xx/5xx (feeds principalStats10m.errorRate). */
  recordError(principal: string, now = Date.now()): void {
    const key = principalKey(principal, minuteBucket(now));
    void this.redis.safe(
      'principal error counter',
      async (c) => {
        await c
          .multi()
          .hincrby(key, 'errors', 1)
          .expire(key, BUCKET_TTL_S)
          .exec();
      },
      undefined,
    );
  }

  /** 10-minute view used by the feature envelope (docs/06 §5); only computed for queued requests. */
  async principalStats10m(
    principal: string,
    now = Date.now(),
  ): Promise<PrincipalStats10m> {
    const buckets = Array.from({ length: 10 }, (_, k) => minuteBucket(now, k));
    return this.redis.safe(
      'principal stats',
      async (c) => {
        const p = c.pipeline();
        for (const b of buckets) p.hgetall(principalKey(principal, b));
        p.pfcount(...buckets.map((b) => pathsKey(principal, b)));
        const results = (await p.exec()) ?? [];
        let requests = 0;
        let errors = 0;
        for (let k = 0; k < buckets.length; k++) {
          const h = (results[k]?.[1] ?? {}) as Record<string, string>;
          requests += Number(h.requests ?? 0);
          errors += Number(h.errors ?? 0);
        }
        const distinctPaths = Number(results[buckets.length]?.[1] ?? 0);
        return {
          requests,
          errorRate:
            requests > 0 ? Math.round((errors / requests) * 1000) / 1000 : 0,
          distinctPaths,
        };
      },
      { requests: 0, errorRate: 0, distinctPaths: 0 },
    );
  }
}
