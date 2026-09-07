import type { Env } from '../config/env.js';
import type { RouteConfig } from '../config/routes.js';

/** A resolved limit: id names the bucket family, window/max are the rule. */
export interface RateLimitPolicyRef {
  id: string;
  windowSeconds: number;
  maxRequests: number;
}

export type RateLimitEnv = Pick<
  Env,
  'RL_DEFAULT_WINDOW_S' | 'RL_DEFAULT_MAX' | 'RL_ANON_MAX'
>;

/** docs/05 §1.1: route policy wins over the API key's policy, which wins over the env default. */
export function resolvePolicy(
  route: RouteConfig,
  keyPolicy: RateLimitPolicyRef | null | undefined,
  env: RateLimitEnv,
): RateLimitPolicyRef {
  if (route.rate_limit) {
    return {
      id: `route:${route.service}`,
      windowSeconds: route.rate_limit.window_seconds,
      maxRequests: route.rate_limit.max_requests,
    };
  }
  if (keyPolicy) return keyPolicy;
  return {
    id: 'default',
    windowSeconds: env.RL_DEFAULT_WINDOW_S,
    maxRequests: env.RL_DEFAULT_MAX,
  };
}

/** Global per-IP cap applied to anonymous traffic on top of the resolved policy. */
export function anonPolicy(env: RateLimitEnv): RateLimitPolicyRef {
  return {
    id: 'anon',
    windowSeconds: env.RL_DEFAULT_WINDOW_S,
    maxRequests: env.RL_ANON_MAX,
  };
}

export const rateLimitKey = (policyId: string, principal: string): string =>
  `rl:${policyId}:${principal}`;

export const throttleKey = (principal: string): string =>
  `throttle:${principal}`;
