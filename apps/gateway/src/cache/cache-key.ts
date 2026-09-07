import { createHash } from 'node:crypto';

export interface CacheKeyInput {
  method: string;
  /** Request pathname without the query string. */
  path: string;
  /** Raw query string, with or without the leading `?`. */
  query: string;
  /** "<type>:<id>" of an authenticated principal when the route varies on principal; omitted otherwise. */
  principal?: string;
  accept?: string;
}

/** Sort query parameters by name, then value, so `?b=2&a=1` and `?a=1&b=2` share an entry (docs/05 §2.2). */
export function normalizeQuery(query: string): string {
  const raw = query.startsWith('?') ? query.slice(1) : query;
  if (!raw) return '';
  const pairs = [...new URLSearchParams(raw).entries()];
  pairs.sort(([ka, va], [kb, vb]) =>
    ka < kb ? -1 : ka > kb ? 1 : va < vb ? -1 : va > vb ? 1 : 0,
  );
  return new URLSearchParams(pairs).toString();
}

/** `cache:{routeId}:{sha1(method | path | sortedQuery | principalIfVary | accept)}` */
export function buildCacheKey(routeId: string, input: CacheKeyInput): string {
  const material = [
    input.method.toUpperCase(),
    input.path,
    normalizeQuery(input.query),
    input.principal ?? '',
    (input.accept ?? '').trim(),
  ].join('|');
  return `cache:${routeId}:${createHash('sha1').update(material).digest('hex')}`;
}

export const cacheIndexKey = (routeId: string): string =>
  `cache:idx:${routeId}`;
export const cacheLockKey = (cacheKey: string): string => `lock:${cacheKey}`;
