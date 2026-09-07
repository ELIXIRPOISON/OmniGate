import type { RouteConfig } from '../config/routes.js';

export const API_PREFIX = '/api';

export interface RouteLookup {
  get(service: string): RouteConfig | undefined;
}

export interface ResolvedRoute {
  service: string;
  route: RouteConfig;
  /** Path + query string to request from the upstream (prefix already stripped when configured). */
  upstreamPath: string;
}

export type ResolveResult =
  | { ok: true; value: ResolvedRoute }
  | {
      ok: false;
      reason: 'missing_service' | 'unknown_service';
      service?: string;
    };

/** `/api/{service}/{rest}?q` -> the route for `{service}` and the path the upstream should see (S1-04). */
export function resolveRoute(
  originalUrl: string,
  routes: RouteLookup,
): ResolveResult {
  const q = originalUrl.indexOf('?');
  const pathname = q === -1 ? originalUrl : originalUrl.slice(0, q);
  const query = q === -1 ? '' : originalUrl.slice(q);

  if (pathname !== API_PREFIX && !pathname.startsWith(`${API_PREFIX}/`)) {
    return { ok: false, reason: 'missing_service' };
  }
  const rest = pathname.slice(API_PREFIX.length + 1);
  const slash = rest.indexOf('/');
  const service = slash === -1 ? rest : rest.slice(0, slash);
  const remainder = slash === -1 ? '' : rest.slice(slash);
  if (!service) return { ok: false, reason: 'missing_service' };

  const route = routes.get(service);
  if (!route) return { ok: false, reason: 'unknown_service', service };

  const upstreamPath =
    (route.strip_prefix ? remainder || '/' : pathname) + query;
  return { ok: true, value: { service, route, upstreamPath } };
}
