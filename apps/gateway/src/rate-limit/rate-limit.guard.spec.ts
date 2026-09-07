import type { ExecutionContext } from '@nestjs/common';
import type { PinoLogger } from 'nestjs-pino';
import type { Principal } from '@omnigate/shared';
import { ProblemException } from '../common/problem/problem.js';
import type { Env } from '../config/env.js';
import type { RouteConfig } from '../config/routes.js';
import type { RedisService } from '../redis/redis.service.js';
import { RateLimitGuard } from './rate-limit.guard.js';
import { parseSlidingWindowResult } from './sliding-window.js';

const env = {
  RL_DEFAULT_WINDOW_S: 60,
  RL_DEFAULT_MAX: 100,
  RL_ANON_MAX: 30,
  RL_FAIL_OPEN: true,
} as Env;
const logger = {
  setContext() {},
  warn() {},
  info() {},
  error() {},
} as unknown as PinoLogger;

const route = (over: Partial<RouteConfig> = {}): RouteConfig => ({
  service: 'svc',
  upstream: 'http://u',
  strip_prefix: true,
  methods: ['*'],
  auth_required: false,
  scopes: [],
  cache_ttl_seconds: 0,
  anomaly_mode: 'async',
  timeout_ms: 1000,
  enabled: true,
  ...over,
});

/** Scripted Redis: returns the given script result, records the arguments it saw. */
function fakeRedis(
  opts: { ready?: boolean; result?: number[]; throws?: boolean } = {},
) {
  const calls: unknown[][] = [];
  const client = {
    defineCommand() {},
    slidingWindow: async (...args: unknown[]) => {
      calls.push(args);
      if (opts.throws) throw new Error('boom');
      return opts.result ?? [-2, 1, 99, Date.now() + 60_000, 0];
    },
  };
  return {
    redis: { client, isReady: opts.ready ?? true } as unknown as RedisService,
    calls,
  };
}

function ctxFor(
  principal: Principal,
  r: RouteConfig,
  keyPolicy?: { id: string; windowSeconds: number; maxRequests: number },
) {
  const headers = new Map<string, string>();
  const res = {
    setHeader: (k: string, v: string) => headers.set(k.toLowerCase(), v),
    locals: {} as Record<string, unknown>,
  };
  const req = {
    id: 'req-1',
    gw: { route: r, service: r.service, upstreamPath: '/' },
    principal,
    keyPolicy,
  };
  const ctx = {
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ExecutionContext;
  return { ctx, headers, res };
}

async function problemOf(p: Promise<unknown>) {
  try {
    await p;
  } catch (err) {
    if (err instanceof ProblemException) return err.problem;
    throw err;
  }
  throw new Error('expected a ProblemException');
}

const user: Principal = { type: 'user', id: 'alice', scopes: [] };
const anon: Principal = { type: 'anon', id: '203.0.113.9', scopes: [] };

describe('RateLimitGuard', () => {
  it('allows and sets X-RateLimit-* headers from the resolved route policy', async () => {
    const { redis, calls } = fakeRedis({
      result: [-2, 1, 41, 1_800_000_000_500, 0],
    });
    const { ctx, headers } = ctxFor(
      user,
      route({ rate_limit: { window_seconds: 60, max_requests: 42 } }),
    );
    await expect(
      new RateLimitGuard(env, redis, logger).canActivate(ctx),
    ).resolves.toBe(true);
    expect(headers.get('x-ratelimit-limit')).toBe('42');
    expect(headers.get('x-ratelimit-remaining')).toBe('41');
    expect(headers.get('x-ratelimit-reset')).toBe('1800000001');
    // numKeys, throttle key, bucket key, now, member, window, max
    expect(calls[0].slice(0, 3)).toEqual([
      2,
      'throttle:user:alice',
      'rl:route:svc:user:alice',
    ]);
    expect(calls[0].slice(5)).toEqual([60_000, 42]);
  });

  it('uses the API key policy when the route has none, else the default', async () => {
    const keyed = fakeRedis();
    await new RateLimitGuard(env, keyed.redis, logger).canActivate(
      ctxFor({ type: 'api_key', id: 'k1', scopes: [] }, route(), {
        id: 'p1',
        windowSeconds: 10,
        maxRequests: 5,
      }).ctx,
    );
    expect(keyed.calls[0][2]).toBe('rl:p1:api_key:k1');
    expect(keyed.calls[0].slice(5)).toEqual([10_000, 5]);
    const dflt = fakeRedis();
    await new RateLimitGuard(env, dflt.redis, logger).canActivate(
      ctxFor(user, route()).ctx,
    );
    expect(dflt.calls[0][2]).toBe('rl:default:user:alice');
    expect(dflt.calls[0].slice(5)).toEqual([60_000, 100]);
  });

  it('denies with 429, Retry-After and the rate_limited flag for the log line', async () => {
    const { redis } = fakeRedis({
      result: [-2, 0, 0, Date.now() + 12_400, 12_400],
    });
    const { ctx, headers, res } = ctxFor(user, route());
    const p = await problemOf(
      new RateLimitGuard(env, redis, logger).canActivate(ctx),
    );
    expect(p).toMatchObject({ status: 429, retryAfter: 13 });
    expect(p.headers?.['Retry-After']).toBe('13');
    expect(p.detail).toContain('100 requests per 60s');
    expect(headers.get('x-ratelimit-remaining')).toBe('0');
    expect(res.locals.rate_limited).toBe(true);
  });

  it('applies the anonymous per-IP cap as a second bucket and reports the tighter one', async () => {
    const { redis, calls } = fakeRedis({ result: [-2, 1, 90, 0, 0, 2, 0, 0] });
    const { ctx, headers } = ctxFor(anon, route());
    await new RateLimitGuard(env, redis, logger).canActivate(ctx);
    expect(calls[0].slice(0, 4)).toEqual([
      3,
      'throttle:anon:203.0.113.9',
      'rl:default:anon:203.0.113.9',
      'rl:anon:anon:203.0.113.9',
    ]);
    expect(calls[0].slice(6)).toEqual([60_000, 100, 60_000, 30]);
    expect(headers.get('x-ratelimit-limit')).toBe('30');
    expect(headers.get('x-ratelimit-remaining')).toBe('2');
  });

  it('names the bucket that denied when several apply', async () => {
    const { redis } = fakeRedis({
      result: [-2, 0, 50, 0, 0, 0, Date.now() + 5000, 5000],
    });
    const p = await problemOf(
      new RateLimitGuard(env, redis, logger).canActivate(
        ctxFor(anon, route()).ctx,
      ),
    );
    expect(p.detail).toContain('Limit of 30 requests per 60s');
    expect(p.retryAfter).toBe(5);
  });

  it('honours the throttle flag (script returns early)', async () => {
    const { redis } = fakeRedis({ result: [25_000, 0] });
    const p = await problemOf(
      new RateLimitGuard(env, redis, logger).canActivate(
        ctxFor(user, route()).ctx,
      ),
    );
    expect(p).toMatchObject({ status: 429, retryAfter: 25 });
    expect(p.detail).toContain('throttled');
  });

  it('fails open with X-RateLimit-Degraded when Redis is down or errors', async () => {
    for (const redis of [
      fakeRedis({ ready: false }).redis,
      fakeRedis({ throws: true }).redis,
    ]) {
      const { ctx, headers } = ctxFor(user, route());
      await expect(
        new RateLimitGuard(env, redis, logger).canActivate(ctx),
      ).resolves.toBe(true);
      expect(headers.get('x-ratelimit-degraded')).toBe('true');
      expect(headers.has('x-ratelimit-limit')).toBe(false);
    }
  });

  it('answers 503 instead when RL_FAIL_OPEN=false', async () => {
    const { ctx } = ctxFor(user, route());
    const p = await problemOf(
      new RateLimitGuard(
        { ...env, RL_FAIL_OPEN: false },
        fakeRedis({ ready: false }).redis,
        logger,
      ).canActivate(ctx),
    );
    expect(p.status).toBe(503);
  });
});

describe('parseSlidingWindowResult', () => {
  it('decodes throttled and multi-bucket shapes and rejects malformed ones', () => {
    expect(parseSlidingWindowResult([1500, 0], 2)).toEqual({
      throttledForMs: 1500,
    });
    expect(parseSlidingWindowResult([-1, 0], 1)).toEqual({
      throttledForMs: -1,
    });
    expect(parseSlidingWindowResult([-2, 1, 9, 100, 0, 1, 200, 0], 2)).toEqual({
      allowed: true,
      buckets: [
        { remaining: 9, resetMs: 100, retryAfterMs: 0 },
        { remaining: 1, resetMs: 200, retryAfterMs: 0 },
      ],
    });
    expect(() => parseSlidingWindowResult([-2, 1, 9], 2)).toThrow(
      /returned 3 values/,
    );
  });
});
