import type { Request } from 'express';
import type { ResolvedRoute } from '../routing/route-resolver.js';

/** Express request enriched by the gateway pipeline. */
export interface GatewayRequest extends Request {
  /** Set by RouteResolverMiddleware for every /api/* request. */
  gw?: ResolvedRoute;
}

export function pathOf(url: string | undefined): string {
  if (!url) return '/';
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}
