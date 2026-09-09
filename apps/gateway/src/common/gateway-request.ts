import type { Request } from 'express';
import type { Principal } from '@omnigate/shared';
import type { AnomalyVerdictOnRequest } from '../anomaly/anomaly.interceptor.js';
import type { RateLimitPolicyRef } from '../rate-limit/policy.js';
import type { ResolvedRoute } from '../routing/route-resolver.js';

/** Express request enriched by the gateway pipeline. */
export interface GatewayRequest extends Request {
  /** Set by RouteResolverMiddleware for every /api/* request. */
  gw?: ResolvedRoute;
  /** Set by AuthGuard: user (JWT), api_key, or anon (client IP) on open routes. */
  principal?: Principal;
  /** Rate-limit policy attached to the API key, when the principal is an api_key (docs/05 §1.1). */
  keyPolicy?: RateLimitPolicyRef | null;
  /** Body buffered by the anomaly pre-screen (bounded by MAX_BODY_BYTES); the proxy replays it. */
  rawBody?: Buffer;
  /** Heuristic verdict and, when queued, the feature envelope. */
  anomaly?: AnomalyVerdictOnRequest;
}

export function pathOf(url: string | undefined): string {
  if (!url) return '/';
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}
