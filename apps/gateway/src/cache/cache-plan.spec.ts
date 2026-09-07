import type { OutgoingHttpHeaders } from 'node:http';
import type { Principal } from '@omnigate/shared';
import type { RouteConfig } from '../config/routes.js';
import { pickStoredHeaders, planCache, storeVerdict } from './cache-plan.js';

const env = { CACHE_DEFAULT_VARY_ON_PRINCIPAL: true };
const route = (over: Partial<RouteConfig> = {}): RouteConfig => ({
  service: 'mock',
  upstream: 'http://u',
  strip_prefix: true,
  methods: ['*'],
  auth_required: false,
  scopes: [],
  cache_ttl_seconds: 30,
  anomaly_mode: 'async',
  timeout_ms: 1000,
  enabled: true,
  ...over,
});
const get = (headers: Record<string, string> = {}, method = 'GET') => ({
  method,
  path: '/api/mock/items',
  query: '',
  headers,
});
const user: Principal = { type: 'user', id: 'alice', scopes: [] };
const bob: Principal = { type: 'user', id: 'bob', scopes: [] };
const anon: Principal = { type: 'anon', id: '1.2.3.4', scopes: [] };

describe('planCache', () => {
  it('skips routes without a TTL, non-GET/HEAD methods and no-store requests', () => {
    expect(
      planCache(get(), route({ cache_ttl_seconds: 0 }), anon, env).mode,
    ).toBe('skip');
    expect(planCache(get({}, 'POST'), route(), anon, env).mode).toBe('skip');
    expect(
      planCache(get({ 'cache-control': 'no-store' }), route(), anon, env).mode,
    ).toBe('skip');
  });

  it('looks up GET and HEAD with the route TTL, under distinct keys', () => {
    const plan = planCache(get(), route(), anon, env);
    expect(plan).toMatchObject({
      mode: 'lookup',
      ttlSeconds: 30,
      indexKey: 'cache:idx:mock',
      routeId: 'mock',
    });
    const head = planCache(get({}, 'HEAD'), route(), anon, env);
    expect(head.mode).toBe('lookup');
    expect(head.key).not.toBe(plan.key);
  });

  it('bypasses the lookup on Cache-Control: no-cache or Pragma: no-cache', () => {
    expect(
      planCache(get({ 'cache-control': 'no-cache' }), route(), anon, env).mode,
    ).toBe('bypass');
    expect(
      planCache(get({ pragma: 'no-cache' }), route(), anon, env).mode,
    ).toBe('bypass');
  });

  it('varies on authenticated principals by default and shares one entry for anonymous callers', () => {
    expect(planCache(get(), route(), user, env).key).not.toBe(
      planCache(get(), route(), bob, env).key,
    );
    expect(planCache(get(), route(), anon, env).key).toBe(
      planCache(get(), route(), { ...anon, id: '5.6.7.8' }, env).key,
    );
  });

  it('can share across principals per route or via the env default', () => {
    const shared = route({ cache_vary_on_principal: false });
    expect(planCache(get(), shared, user, env).key).toBe(
      planCache(get(), shared, bob, env).key,
    );
    const off = { CACHE_DEFAULT_VARY_ON_PRINCIPAL: false };
    expect(planCache(get(), route(), user, off).key).toBe(
      planCache(get(), route(), bob, off).key,
    );
    expect(
      planCache(get(), route({ cache_vary_on_principal: true }), user, off).key,
    ).not.toBe(
      planCache(get(), route({ cache_vary_on_principal: true }), bob, off).key,
    );
  });
});

describe('storeVerdict', () => {
  const max = 1000;
  it('accepts the documented statuses and rejects the rest', () => {
    for (const s of [200, 203, 204, 301, 404])
      expect(storeVerdict(s, {}, 10, max).ok).toBe(true);
    for (const s of [201, 302, 400, 401, 429, 500, 502])
      expect(storeVerdict(s, {}, 10, max).ok).toBe(false);
  });
  it('rejects private / no-store upstream responses, Set-Cookie, truncated and oversized bodies', () => {
    expect(
      storeVerdict(200, { 'cache-control': 'private, max-age=60' }, 10, max).ok,
    ).toBe(false);
    expect(storeVerdict(200, { 'cache-control': 'no-store' }, 10, max).ok).toBe(
      false,
    );
    expect(
      storeVerdict(200, { 'cache-control': 'public, max-age=60' }, 10, max).ok,
    ).toBe(true);
    expect(storeVerdict(200, { 'set-cookie': ['a=b'] }, 10, max).ok).toBe(
      false,
    );
    expect(storeVerdict(200, {}, null, max).ok).toBe(false);
    expect(storeVerdict(200, {}, 1001, max).ok).toBe(false);
  });
});

describe('pickStoredHeaders', () => {
  it('keeps only the whitelist and stringifies values', () => {
    const headers = {
      'content-type': 'application/json',
      etag: 'W/"1"',
      'x-request-id': 'r',
      'set-cookie': ['a'],
      vary: ['Accept', 'Origin'],
      'content-length': 12,
    } as unknown as OutgoingHttpHeaders;
    expect(pickStoredHeaders(headers)).toEqual({
      'content-type': 'application/json',
      etag: 'W/"1"',
      vary: 'Accept, Origin',
    });
  });
});
