import { EnvValidationError, loadEnv } from './env.js';

const base: NodeJS.ProcessEnv = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'x'.repeat(32),
  API_KEY_PEPPER: 'p'.repeat(16),
  ADMIN_EMAIL: 'admin@example.com',
  ADMIN_PASSWORD: 'admin',
  ADMIN_JWT_SECRET: 'a'.repeat(16),
  LLM_PROVIDER: 'fake',
};

describe('loadEnv', () => {
  it('applies documented defaults', () => {
    const env = loadEnv(base);
    expect(env.PORT).toBe(8080);
    expect(env.NODE_ENV).toBe('development');
    expect(env.TRUST_PROXY).toBe(false);
    expect(env.ROUTES_FILE).toBe('./routes.yaml');
    expect(env.MAX_BODY_BYTES).toBe(1_048_576);
    expect(env.UPSTREAM_TIMEOUT_MS).toBe(30_000);
    expect(env.RL_FAIL_OPEN).toBe(true);
  });

  it('fails fast with a readable message when REDIS_URL is missing', () => {
    const { REDIS_URL: _omitted, ...withoutRedis } = base;
    expect(() => loadEnv(withoutRedis)).toThrow(EnvValidationError);
    expect(() => loadEnv(withoutRedis)).toThrow(/REDIS_URL: is required/);
  });

  it('rejects a Redis URL with the wrong scheme', () => {
    expect(() =>
      loadEnv({ ...base, REDIS_URL: 'http://localhost:6379' }),
    ).toThrow(/REDIS_URL/);
  });

  it('coerces numbers and booleans from strings', () => {
    const env = loadEnv({
      ...base,
      PORT: '9090',
      TRUST_PROXY: 'true',
      ANOMALY_SAMPLE_RATE: '0.5',
    });
    expect(env.PORT).toBe(9090);
    expect(env.TRUST_PROXY).toBe(true);
    expect(env.ANOMALY_SAMPLE_RATE).toBe(0.5);
  });

  it('treats empty strings as unset', () => {
    expect(loadEnv({ ...base, PORT: '' }).PORT).toBe(8080);
  });

  it('requires one of JWT_SECRET or JWT_JWKS_URL', () => {
    const { JWT_SECRET: _omitted, ...noJwt } = base;
    expect(() => loadEnv(noJwt)).toThrow(/JWT_SECRET/);
    expect(
      loadEnv({
        ...noJwt,
        JWT_JWKS_URL: 'https://issuer.example.com/jwks.json',
      }).JWT_JWKS_URL,
    ).toBeDefined();
  });

  it('requires the admin secret to differ from the gateway JWT secret', () => {
    expect(() =>
      loadEnv({ ...base, ADMIN_JWT_SECRET: base.JWT_SECRET }),
    ).toThrow(/ADMIN_JWT_SECRET/);
  });

  it('requires LLM_API_KEY unless the provider is fake or local', () => {
    expect(() => loadEnv({ ...base, LLM_PROVIDER: 'openai' })).toThrow(
      /LLM_API_KEY/,
    );
    expect(
      loadEnv({ ...base, LLM_PROVIDER: 'openai', LLM_API_KEY: 'sk' })
        .LLM_PROVIDER,
    ).toBe('openai');
    expect(loadEnv({ ...base, LLM_PROVIDER: 'local' }).LLM_PROVIDER).toBe(
      'local',
    );
  });

  it('lists every problem at once', () => {
    const { REDIS_URL: _r, DATABASE_URL: _d, ...broken } = base;
    try {
      loadEnv(broken);
      throw new Error('expected loadEnv to throw');
    } catch (err) {
      const e = err as EnvValidationError;
      expect(e.issues.map((i) => i.key).sort()).toEqual([
        'DATABASE_URL',
        'REDIS_URL',
      ]);
    }
  });
});
