import type { RouteConfig } from '../config/routes.js';
import {
  anonPolicy,
  rateLimitKey,
  resolvePolicy,
  throttleKey,
} from './policy.js';

const env = { RL_DEFAULT_WINDOW_S: 60, RL_DEFAULT_MAX: 100, RL_ANON_MAX: 30 };
const route = (over: Partial<RouteConfig> = {}): RouteConfig => ({
  service: 'orders',
  upstream: 'http://u',
  strip_prefix: true,
  methods: ['*'],
  auth_required: true,
  scopes: [],
  cache_ttl_seconds: 0,
  anomaly_mode: 'async',
  timeout_ms: 1000,
  enabled: true,
  ...over,
});
const keyPolicy = { id: 'p-strict', windowSeconds: 60, maxRequests: 10 };

describe('resolvePolicy', () => {
  it('prefers the route policy', () => {
    const r = route({ rate_limit: { window_seconds: 30, max_requests: 5 } });
    expect(resolvePolicy(r, keyPolicy, env)).toEqual({
      id: 'route:orders',
      windowSeconds: 30,
      maxRequests: 5,
    });
  });
  it('falls back to the API key policy, then the env default', () => {
    expect(resolvePolicy(route(), keyPolicy, env)).toBe(keyPolicy);
    expect(resolvePolicy(route(), null, env)).toEqual({
      id: 'default',
      windowSeconds: 60,
      maxRequests: 100,
    });
  });
  it('builds the documented keys', () => {
    expect(anonPolicy(env)).toEqual({
      id: 'anon',
      windowSeconds: 60,
      maxRequests: 30,
    });
    expect(rateLimitKey('default', 'api_key:k1')).toBe('rl:default:api_key:k1');
    expect(throttleKey('anon:1.2.3.4')).toBe('throttle:anon:1.2.3.4');
  });
});
