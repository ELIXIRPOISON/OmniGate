import {
  interpolateEnv,
  parseRoutes,
  RoutesValidationError,
} from './routes.js';

const minimal = `
routes:
  - service: orders
    upstream: http://localhost:3001
`;

describe('parseRoutes', () => {
  it('applies defaults to a minimal route', () => {
    const [route] = parseRoutes(minimal, { env: {} });
    expect(route).toMatchObject({
      service: 'orders',
      upstream: 'http://localhost:3001',
      strip_prefix: true,
      methods: ['*'],
      auth_required: true,
      scopes: [],
      cache_ttl_seconds: 0,
      anomaly_mode: 'async',
      timeout_ms: 30_000,
      enabled: true,
    });
  });

  it('uses the configured default timeout when a route omits timeout_ms', () => {
    const [route] = parseRoutes(minimal, { env: {}, defaultTimeoutMs: 5_000 });
    expect(route.timeout_ms).toBe(5_000);
  });

  it('keeps an explicit timeout and uppercases methods', () => {
    const [route] = parseRoutes(
      `${minimal}    timeout_ms: 1500\n    methods: [get, post]\n`,
      { env: {} },
    );
    expect(route.timeout_ms).toBe(1500);
    expect(route.methods).toEqual(['GET', 'POST']);
  });

  it('drops disabled routes', () => {
    const routes = parseRoutes(`${minimal}    enabled: false\n`, { env: {} });
    expect(routes).toEqual([]);
  });

  it('rejects duplicate services', () => {
    const text = `${minimal}  - service: orders\n    upstream: http://localhost:3002\n`;
    expect(() => parseRoutes(text, { env: {} })).toThrow(
      /duplicate service "orders"/,
    );
  });

  it('rejects a non-http upstream and a bad service name', () => {
    expect(() =>
      parseRoutes('routes:\n  - service: Orders\n    upstream: ftp://x\n', {
        env: {},
      }),
    ).toThrow(RoutesValidationError);
  });

  it('rejects invalid YAML with a readable error', () => {
    expect(() => parseRoutes('routes: [\n', { env: {} })).toThrow(
      /not valid YAML/,
    );
  });

  it('accepts an empty file as zero routes', () => {
    expect(parseRoutes('', { env: {} })).toEqual([]);
  });
});

describe('interpolateEnv', () => {
  it('substitutes set variables and falls back to defaults', () => {
    const out = interpolateEnv('a=${A} b=${B:-dflt} c=${C:-}', { A: '1' });
    expect(out).toBe('a=1 b=dflt c=');
  });

  it('treats an empty variable as unset', () => {
    expect(interpolateEnv('${A:-x}', { A: '' })).toBe('x');
  });

  it('throws when a variable is missing and has no default', () => {
    expect(() => interpolateEnv('${MISSING}', {})).toThrow(/MISSING/);
  });

  it('feeds through to the upstream URL', () => {
    const [route] = parseRoutes(
      'routes:\n  - service: mock\n    upstream: ${MOCK_UPSTREAM_URL:-http://localhost:3001}\n',
      { env: { MOCK_UPSTREAM_URL: 'http://mock-upstream:3001' } },
    );
    expect(route.upstream).toBe('http://mock-upstream:3001');
  });
});
