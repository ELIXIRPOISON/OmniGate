/**
 * Integration suites share one worker process, so `process.env` written by one file is still there
 * when the next file boots its app. A suite that does not mention a variable would silently inherit
 * the previous suite's value - for example ANOMALY_AUTO_THROTTLE, which can then throttle a
 * principal in a completely unrelated test. Clearing the gateway's own namespace first makes every
 * suite depend only on what it sets, and on the schema defaults for everything else.
 */
const MANAGED_PREFIXES = [
  'ANOMALY_',
  'LLM_',
  'RL_',
  'CACHE_',
  'JWT_',
  'ADMIN_',
  'API_KEY_',
] as const;

const MANAGED_KEYS = [
  'NODE_ENV',
  'LOG_LEVEL',
  'ROUTES_FILE',
  'DATABASE_URL',
  'REDIS_URL',
  'TRUST_PROXY',
  'MAX_BODY_BYTES',
  'UPSTREAM_TIMEOUT_MS',
  'EXPOSE_ANOMALY_SCORE',
  'WORKER_INLINE',
  'ALLOW_PRIVATE_UPSTREAMS',
  'CORS_ORIGIN',
  'MOCK_UPSTREAM_URL',
  'PORT',
] as const;

export function applyTestEnv(vars: Record<string, string>): void {
  for (const key of Object.keys(process.env)) {
    if (
      MANAGED_PREFIXES.some((p) => key.startsWith(p)) ||
      (MANAGED_KEYS as readonly string[]).includes(key)
    ) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, vars);
}
