import type { ExecutionContext } from '@nestjs/common';
import type { Principal } from '@omnigate/shared';
import { ProblemException } from '../common/problem/problem.js';
import type { RouteConfig } from '../config/routes.js';
import type { ApiKeyService } from './api-key.service.js';
import { AuthError } from './auth-error.js';
import { AuthGuard, bearerToken } from './auth.guard.js';
import type { JwtVerifier } from './jwt.verifier.js';

const route = (over: Partial<RouteConfig> = {}): RouteConfig => ({
  service: 'svc',
  upstream: 'http://u',
  strip_prefix: true,
  methods: ['*'],
  auth_required: true,
  scopes: [],
  cache_ttl_seconds: 0,
  anomaly_mode: 'async',
  block_on_heuristic: false,
  timeout_ms: 1000,
  enabled: true,
  ...over,
});

function ctxFor(headers: Record<string, string>, r: RouteConfig) {
  const req = {
    headers,
    ip: '203.0.113.9',
    socket: { remoteAddress: '203.0.113.9' },
    gw: { route: r, service: r.service, upstreamPath: '/' },
  } as never as {
    principal?: Principal;
  };
  const ctx = {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
  return { req, ctx };
}

const user: Principal = { type: 'user', id: 'alice', scopes: ['orders:read'] };
const key: Principal = { type: 'api_key', id: 'k1', scopes: ['orders:read'] };

function guardWith(
  jwt: Partial<JwtVerifier> = {},
  keys: Partial<ApiKeyService> = {},
) {
  return new AuthGuard(
    { verify: async () => user, ...jwt } as JwtVerifier,
    {
      authenticate: async () => ({ principal: key, policy: null }),
      ...keys,
    } as ApiKeyService,
  );
}

async function problemOf(p: Promise<unknown>) {
  try {
    await p;
  } catch (err) {
    if (err instanceof ProblemException) return err.problem;
    throw err;
  }
  throw new Error('expected a ProblemException');
}

describe('AuthGuard', () => {
  it('rejects a protected route without credentials with 401 + WWW-Authenticate', async () => {
    const { ctx } = ctxFor({}, route());
    const p = await problemOf(guardWith().canActivate(ctx));
    expect(p.status).toBe(401);
    expect(p.headers?.['WWW-Authenticate']).toContain('Bearer');
  });

  it('lets an open route through anonymously with the client IP as principal', async () => {
    const { ctx, req } = ctxFor({}, route({ auth_required: false }));
    await expect(guardWith().canActivate(ctx)).resolves.toBe(true);
    expect(req.principal).toEqual({
      type: 'anon',
      id: '203.0.113.9',
      scopes: [],
    });
  });

  it('authenticates a bearer token before an API key when both are present', async () => {
    const keys = {
      authenticate: vi.fn(async () => ({ principal: key, policy: null })),
    };
    const { ctx, req } = ctxFor(
      { authorization: 'Bearer t', 'x-api-key': 'gw_live_x' },
      route(),
    );
    await guardWith({}, keys).canActivate(ctx);
    expect(req.principal).toEqual(user);
    expect(keys.authenticate).not.toHaveBeenCalled();
  });

  it('authenticates an API key', async () => {
    const { ctx, req } = ctxFor({ 'x-api-key': 'gw_live_x' }, route());
    await guardWith().canActivate(ctx);
    expect(req.principal).toEqual(key);
  });

  it('rejects invalid credentials even on open routes', async () => {
    const jwt = {
      verify: async () => {
        throw new AuthError('expired', 'Token expired');
      },
    };
    const { ctx } = ctxFor(
      { authorization: 'Bearer old' },
      route({ auth_required: false }),
    );
    const p = await problemOf(guardWith(jwt).canActivate(ctx));
    expect(p).toMatchObject({ status: 401, detail: 'Token expired' });
  });

  it('maps revoked and expired keys to 403 and store outages to 503', async () => {
    for (const [reason, status] of [
      ['revoked', 403],
      ['key_expired', 403],
      ['unavailable', 503],
      ['invalid', 401],
    ] as const) {
      const keys = {
        authenticate: async () => {
          throw new AuthError(reason, reason);
        },
      };
      const { ctx } = ctxFor({ 'x-api-key': 'gw_live_x' }, route());
      expect(
        (await problemOf(guardWith({}, keys).canActivate(ctx))).status,
      ).toBe(status);
    }
  });

  it('enforces route scopes with 403 insufficient_scope', async () => {
    const { ctx } = ctxFor(
      { authorization: 'Bearer t' },
      route({ scopes: ['orders:write'] }),
    );
    const p = await problemOf(guardWith().canActivate(ctx));
    expect(p.status).toBe(403);
    expect(p.headers?.['WWW-Authenticate']).toContain('insufficient_scope');
    expect(p.detail).toContain('orders:write');
  });

  it('accepts when any one of the route scopes is present', async () => {
    const { ctx } = ctxFor(
      { authorization: 'Bearer t' },
      route({ scopes: ['orders:write', 'orders:read'] }),
    );
    await expect(guardWith().canActivate(ctx)).resolves.toBe(true);
  });

  it('treats scoped routes as requiring authentication even if auth_required is false', async () => {
    const { ctx } = ctxFor(
      {},
      route({ auth_required: false, scopes: ['orders:read'] }),
    );
    expect((await problemOf(guardWith().canActivate(ctx))).status).toBe(401);
  });

  it('rejects non-bearer authorization schemes', async () => {
    const { ctx } = ctxFor({ authorization: 'Basic abc' }, route());
    expect((await problemOf(guardWith().canActivate(ctx))).status).toBe(401);
  });
});

describe('bearerToken', () => {
  it('parses case-insensitively and rejects empty or malformed values', () => {
    expect(bearerToken('Bearer abc.def')).toBe('abc.def');
    expect(bearerToken('bearer   x ')).toBe('x');
    expect(() => bearerToken('Bearer')).toThrow(AuthError);
    expect(() => bearerToken('Token x')).toThrow(AuthError);
  });
});
