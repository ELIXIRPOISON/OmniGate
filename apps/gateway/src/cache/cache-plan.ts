import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http';
import type { Principal } from '@omnigate/shared';
import { formatPrincipal } from '@omnigate/shared';
import type { RouteConfig } from '../config/routes.js';
import { buildCacheKey, cacheIndexKey } from './cache-key.js';

export type CacheMode =
  /** Not cacheable at all: no lookup, no store, no X-Cache header. */
  | 'skip'
  /** Look up first; store on miss. */
  | 'lookup'
  /** Request said Cache-Control: no-cache -> skip the lookup but refresh the entry (X-Cache: BYPASS). */
  | 'bypass';

export interface CachePlan {
  mode: CacheMode;
  key: string;
  indexKey: string;
  ttlSeconds: number;
  routeId: string;
}

export interface CachePlanEnv {
  CACHE_DEFAULT_VARY_ON_PRINCIPAL: boolean;
}

interface PlanRequest {
  method: string;
  /** Pathname without query. */
  path: string;
  query: string;
  headers: IncomingHttpHeaders;
}

const CACHEABLE_METHODS = new Set(['GET', 'HEAD']);
/** Upstream statuses worth remembering (docs/05 §2.1). */
export const STORABLE_STATUSES = new Set([200, 203, 204, 301, 404]);

function directives(value: string | string[] | undefined): Set<string> {
  const text = Array.isArray(value) ? value.join(',') : (value ?? '');
  return new Set(
    text
      .split(',')
      .map((d) => d.trim().toLowerCase().split('=')[0])
      .filter(Boolean),
  );
}

/** Decide, before the upstream call, whether and how this request participates in the cache. */
export function planCache(
  req: PlanRequest,
  route: RouteConfig,
  principal: Principal | undefined,
  env: CachePlanEnv,
): CachePlan {
  const routeId = route.service;
  const none: CachePlan = {
    mode: 'skip',
    key: '',
    indexKey: cacheIndexKey(routeId),
    ttlSeconds: 0,
    routeId,
  };
  if (route.cache_ttl_seconds <= 0) return none;
  if (!CACHEABLE_METHODS.has(req.method.toUpperCase())) return none;

  const cc = directives(req.headers['cache-control']);
  if (cc.has('no-store')) return none;

  const vary =
    route.cache_vary_on_principal ?? env.CACHE_DEFAULT_VARY_ON_PRINCIPAL;
  // Anonymous callers share one entry even when varying: a public route's response does not depend on the IP.
  const principalPart =
    vary && principal && principal.type !== 'anon'
      ? formatPrincipal(principal)
      : undefined;
  const key = buildCacheKey(routeId, {
    method: req.method,
    path: req.path,
    query: req.query,
    principal: principalPart,
    accept:
      typeof req.headers.accept === 'string' ? req.headers.accept : undefined,
  });

  const bypass =
    cc.has('no-cache') || directives(req.headers.pragma).has('no-cache');
  return {
    mode: bypass ? 'bypass' : 'lookup',
    key,
    indexKey: cacheIndexKey(routeId),
    ttlSeconds: route.cache_ttl_seconds,
    routeId,
  };
}

/** Headers copied into the cache entry and replayed on a HIT (docs/05 §2.3 whitelist). */
export const STORED_HEADERS = [
  'content-type',
  'content-encoding',
  'etag',
  'last-modified',
  'cache-control',
  'vary',
] as const;

export function pickStoredHeaders(
  headers: OutgoingHttpHeaders,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of STORED_HEADERS) {
    const v = headers[name] as string | number | string[] | undefined;
    if (typeof v === 'string') out[name] = v;
    else if (typeof v === 'number') out[name] = String(v);
    else if (Array.isArray(v)) out[name] = v.join(', ');
  }
  return out;
}

export type StoreVerdict = { ok: true } | { ok: false; reason: string };

/** Decide, once the upstream answered, whether the response may be stored. */
export function storeVerdict(
  status: number,
  headers: OutgoingHttpHeaders,
  bodyBytes: number | null,
  maxBytes: number,
): StoreVerdict {
  if (!STORABLE_STATUSES.has(status))
    return { ok: false, reason: `status ${status}` };
  const cc = directives(
    headers['cache-control'] as string | string[] | undefined,
  );
  if (cc.has('private') || cc.has('no-store'))
    return { ok: false, reason: 'upstream cache-control' };
  if (headers['set-cookie']) return { ok: false, reason: 'set-cookie' };
  if (bodyBytes === null) return { ok: false, reason: 'body truncated' };
  if (bodyBytes > maxBytes)
    return { ok: false, reason: `body ${bodyBytes} > ${maxBytes}` };
  return { ok: true };
}
