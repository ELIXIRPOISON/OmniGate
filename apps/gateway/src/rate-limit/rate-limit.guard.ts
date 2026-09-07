import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
import type { Response } from 'express';
import { PinoLogger } from 'nestjs-pino';
import { formatPrincipal } from '@omnigate/shared';
import type { GatewayRequest } from '../common/gateway-request.js';
import { Problems } from '../common/problem/problem.js';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { RedisService } from '../redis/redis.service.js';
import {
  anonPolicy,
  type RateLimitPolicyRef,
  rateLimitKey,
  resolvePolicy,
  throttleKey,
} from './policy.js';
import {
  registerSlidingWindow,
  runSlidingWindow,
  type SlidingWindowDecision,
} from './sliding-window.js';

const FAIL_OPEN_LOG_INTERVAL_MS = 60_000;
/** Retry-After used when a throttle flag has no TTL (should not happen; the admin API always sets one). */
const INDEFINITE_THROTTLE_RETRY_S = 600;

interface Check {
  key: string;
  policy: RateLimitPolicyRef;
}

/**
 * Step 4 of the lifecycle (docs/02 §3, docs/05 §1.3). One Redis round trip per request: a single
 * Lua call checks the throttle flag, then evaluates every applicable bucket (the resolved policy,
 * plus the global anonymous cap for anon principals) atomically.
 * Redis trouble never turns into a 5xx: with RL_FAIL_OPEN the request is allowed and marked
 * X-RateLimit-Degraded (T17), otherwise it is answered 503.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private lastFailOpenLog = 0;

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly redis: RedisService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(RateLimitGuard.name);
    registerSlidingWindow(this.redis.client);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<GatewayRequest>();
    const res = context.switchToHttp().getResponse<Response>();
    const route = req.gw?.route;
    const principal = req.principal;
    if (!route || !principal) {
      throw new Error(
        'RateLimitGuard requires RouteResolverMiddleware and AuthGuard',
      );
    }

    const who = formatPrincipal(principal);
    const policy = resolvePolicy(route, req.keyPolicy, this.env);
    const checks: Check[] = [{ key: rateLimitKey(policy.id, who), policy }];
    if (principal.type === 'anon') {
      const anon = anonPolicy(this.env);
      checks.push({ key: rateLimitKey(anon.id, who), policy: anon });
    }

    let decision: SlidingWindowDecision;
    try {
      if (!this.redis.isReady) throw new Error('redis not connected');
      decision = await runSlidingWindow(
        this.redis.client,
        throttleKey(who),
        checks.map((c) => ({
          key: c.key,
          windowMs: c.policy.windowSeconds * 1000,
          max: c.policy.maxRequests,
        })),
        Date.now(),
        `${Date.now()}:${String(req.id)}`,
      );
    } catch (err) {
      if (!this.env.RL_FAIL_OPEN)
        throw Problems.serviceUnavailable('Rate limiter unavailable');
      res.setHeader('X-RateLimit-Degraded', 'true');
      this.logFailOpen(err as Error);
      return true;
    }

    if ('throttledForMs' in decision) {
      res.locals.rate_limited = true;
      const retryAfterS =
        decision.throttledForMs === -1
          ? INDEFINITE_THROTTLE_RETRY_S
          : Math.max(1, Math.ceil(decision.throttledForMs / 1000));
      throw Problems.rateLimited(
        `${who} is temporarily throttled`,
        retryAfterS,
      );
    }

    // Headers describe the most restrictive applicable limit.
    const outcomes = decision.buckets.map((b, i) => ({
      ...b,
      policy: checks[i].policy,
    }));
    const tightest = outcomes.reduce((a, b) =>
      b.remaining < a.remaining ? b : a,
    );
    res.setHeader('X-RateLimit-Limit', String(tightest.policy.maxRequests));
    res.setHeader('X-RateLimit-Remaining', String(tightest.remaining));
    res.setHeader(
      'X-RateLimit-Reset',
      String(Math.ceil(tightest.resetMs / 1000)),
    );

    if (!decision.allowed) {
      res.locals.rate_limited = true;
      const denying = outcomes.filter((o) => o.retryAfterMs > 0);
      const worst = denying.reduce(
        (a, b) => (b.retryAfterMs > a.retryAfterMs ? b : a),
        denying[0] ?? tightest,
      );
      const retryAfterS = Math.max(1, Math.ceil(worst.retryAfterMs / 1000));
      throw Problems.rateLimited(
        `Limit of ${worst.policy.maxRequests} requests per ${worst.policy.windowSeconds}s exceeded for ${who}`,
        retryAfterS,
      );
    }
    return true;
  }

  private logFailOpen(err: Error): void {
    const now = Date.now();
    if (now - this.lastFailOpenLog < FAIL_OPEN_LOG_INTERVAL_MS) return;
    this.lastFailOpenLog = now;
    this.logger.warn(
      { err_message: err.message },
      'rate_limit.fail_open: Redis unavailable, allowing requests unlimited',
    );
  }
}
