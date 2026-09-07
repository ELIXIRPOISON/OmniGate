import type { RouteConfig } from '../config/routes.js';
import { resolveRoute } from './route-resolver.js';

const route = (over: Partial<RouteConfig> = {}): RouteConfig => ({
  service: 'orders',
  upstream: 'http://upstream:3001',
  strip_prefix: true,
  methods: ['*'],
  auth_required: true,
  scopes: [],
  cache_ttl_seconds: 0,
  anomaly_mode: 'async',
  timeout_ms: 30_000,
  enabled: true,
  ...over,
});

const registry = (routes: RouteConfig[]) => ({
  get: (s: string) => routes.find((r) => r.service === s),
});

describe('resolveRoute', () => {
  it('resolves the service segment and strips the prefix', () => {
    const r = resolveRoute('/api/orders/v1/x?id=1', registry([route()]));
    expect(r).toEqual({
      ok: true,
      value: { service: 'orders', route: route(), upstreamPath: '/v1/x?id=1' },
    });
  });

  it('keeps the full path when strip_prefix is false', () => {
    const r = resolveRoute(
      '/api/orders/v1/x',
      registry([route({ strip_prefix: false })]),
    );
    expect(r.ok && r.value.upstreamPath).toBe('/api/orders/v1/x');
  });

  it('maps a bare service path to the upstream root', () => {
    expect(resolveRoute('/api/orders', registry([route()])).ok && '/').toBe(
      '/',
    );
    const r = resolveRoute('/api/orders/', registry([route()]));
    expect(r.ok && r.value.upstreamPath).toBe('/');
  });

  it('reports unknown services', () => {
    expect(resolveRoute('/api/nope/x', registry([route()]))).toEqual({
      ok: false,
      reason: 'unknown_service',
      service: 'nope',
    });
  });

  it('reports a missing service segment', () => {
    expect(resolveRoute('/api', registry([route()]))).toMatchObject({
      reason: 'missing_service',
    });
    expect(resolveRoute('/api/', registry([route()]))).toMatchObject({
      reason: 'missing_service',
    });
    expect(resolveRoute('/apix/orders', registry([route()]))).toMatchObject({
      reason: 'missing_service',
    });
  });
});
