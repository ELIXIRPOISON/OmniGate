import { z } from 'zod';

const bool = () => z.stringbool();
const int = () => z.coerce.number().int();
const ratio = () => z.coerce.number().min(0).max(1);

/** Every variable the gateway reads. Keep in sync with .env.example and docs/10 §3. */
export const envSchema = z
  .object({
    PORT: int().min(1).max(65535).default(8080),
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    TRUST_PROXY: bool().default(false),

    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    REDIS_URL: z.url({ protocol: /^rediss?$/ }),

    ROUTES_FILE: z.string().min(1).default('./routes.yaml'),
    ALLOW_PRIVATE_UPSTREAMS: bool().default(false),

    JWT_SECRET: z.string().min(32).optional(),
    /**
     * Expected `iss` and `aud` claims. Optional, but without them any token the configured key or
     * JWKS can verify is accepted, which for a shared identity provider means tokens minted for a
     * different application. Set both when JWT_JWKS_URL points at a provider you do not own.
     */
    JWT_ISSUER: z.string().min(1).optional(),
    JWT_AUDIENCE: z.string().min(1).optional(),
    JWT_JWKS_URL: z.url().optional(),
    API_KEY_PEPPER: z.string().min(16),

    ADMIN_EMAIL: z.email(),
    ADMIN_PASSWORD: z.string().min(1),
    ADMIN_JWT_SECRET: z.string().min(16),
    CORS_ORIGIN: z.string().min(1).default('http://localhost:5173'),

    MAX_BODY_BYTES: int().positive().default(1_048_576),
    UPSTREAM_TIMEOUT_MS: int().positive().default(30_000),

    RL_DEFAULT_WINDOW_S: int().positive().default(60),
    RL_DEFAULT_MAX: int().positive().default(100),
    RL_ANON_MAX: int().positive().default(30),
    RL_COUNT_CACHE_HITS: bool().default(true),
    RL_FAIL_OPEN: bool().default(true),
    CACHE_MAX_BODY_BYTES: int().positive().default(262_144),
    CACHE_DEFAULT_VARY_ON_PRINCIPAL: bool().default(true),

    ANOMALY_SAMPLE_RATE: ratio().default(0.02),
    ANOMALY_GATE_THRESHOLD: ratio().default(0.4),
    ANOMALY_BLOCK_THRESHOLD: ratio().default(0.9),
    ANOMALY_AUTO_THROTTLE: bool().default(false),
    /**
     * Global switch for every refusal the anomaly stage can make: the heuristic fast block, a sync
     * route's 403 and the reactive throttle. Off means observe only - everything is still scored,
     * recorded and reviewable, nothing is refused - regardless of per-route settings. Run a new
     * deployment with this off until the review queue has earned trust.
     */
    ANOMALY_ENFORCE: bool().default(true),
    /** Learned per-route parameter schema (docs/results/anomaly-eval-csic.md). */
    SCHEMA_LEARNING: bool().default(true),
    /** Successful, unremarkable requests a route must contribute before the signal activates. */
    SCHEMA_WARMUP_REQUESTS: int().nonnegative().default(500),
    /** Distinct callers that must use a new parameter name before it counts as legitimate. */
    SCHEMA_PROMOTE_PRINCIPALS: int().positive().default(3),
    /** Past this many names a route is treated as unmodellable and the signal disables itself. */
    SCHEMA_MAX_NAMES: int().positive().default(256),
    /**
     * Also check that values look like what the parameter has carried before. Off by default: it is
     * the largest single recall gain available and the only signal with a non-zero false-positive
     * count, so it is the operator's trade to make (docs/results/anomaly-eval-csic.md).
     */
    SCHEMA_VALUE_SHAPES: bool().default(false),
    // `fake` so a deployment that never configures a model boots and runs heuristics-only. `openai`
    // as the default made a bare image refuse to start for want of an LLM_API_KEY nobody had asked for.
    LLM_PROVIDER: z
      .enum(['openai', 'anthropic', 'local', 'fake'])
      .default('fake'),
    LLM_MODEL: z.string().min(1).optional(),
    LLM_API_KEY: z.string().min(1).optional(),
    LLM_DAILY_CALL_CAP: int().nonnegative().default(20_000),
    /** Override for any OpenAI-compatible endpoint (Groq, Together, vLLM, Ollama /v1) or a proxy. */
    LLM_BASE_URL: z.url().optional(),
    LLM_MAX_OUTPUT_TOKENS: int().positive().max(4_000).default(200),
    /** Await budget for routes in sync mode; exceeding it fails open. */
    LLM_TIMEOUT_SYNC_MS: int().positive().default(800),
    LLM_TIMEOUT_ASYNC_MS: int().positive().default(5_000),
    ANOMALY_THROTTLE_EVENTS: int().positive().default(3),
    ANOMALY_THROTTLE_WINDOW_S: int().positive().default(300),
    ANOMALY_THROTTLE_SECONDS: int().positive().default(600),

    WORKER_INLINE: bool().default(true),
    LOG_RETENTION_DAYS: int().positive().default(30),
    EXPOSE_ANOMALY_SCORE: bool().default(false),
    /**
     * Bearer token for /metrics. Unset serves the endpoint in development and hides it in
     * production: an open metrics endpoint on a public URL discloses traffic shape and how close
     * the anomaly stage is to firing.
     */
    METRICS_TOKEN: z.string().min(16).optional(),
  })
  .superRefine((env, ctx) => {
    if (!env.JWT_SECRET && !env.JWT_JWKS_URL) {
      ctx.addIssue({
        code: 'custom',
        path: ['JWT_SECRET'],
        message: 'set JWT_SECRET (HS256) or JWT_JWKS_URL (RS256)',
      });
    }
    if (env.JWT_SECRET && env.ADMIN_JWT_SECRET === env.JWT_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['ADMIN_JWT_SECRET'],
        message: 'must differ from JWT_SECRET',
      });
    }
    // Production must not boot on the values .env.example ships with. A deploy that silently keeps
    // the sample admin password is worse than one that refuses to start, because nobody finds out.
    if (env.NODE_ENV === 'production') {
      const shipped = [
        ['ADMIN_PASSWORD', env.ADMIN_PASSWORD],
        ['JWT_SECRET', env.JWT_SECRET],
        ['API_KEY_PEPPER', env.API_KEY_PEPPER],
        ['ADMIN_JWT_SECRET', env.ADMIN_JWT_SECRET],
      ] as const;
      for (const [key, value] of shipped) {
        if (value && (value === 'admin' || /dev-only|change-me/i.test(value))) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message:
              'still set to the value from .env.example; generate a real one before deploying',
          });
        }
      }
      if (env.EXPOSE_ANOMALY_SCORE) {
        ctx.addIssue({
          code: 'custom',
          path: ['EXPOSE_ANOMALY_SCORE'],
          message:
            'must be false in production: it tells a caller exactly how close their probe came to the threshold',
        });
      }
    }
    if (
      env.LLM_PROVIDER !== 'fake' &&
      env.LLM_PROVIDER !== 'local' &&
      !env.LLM_API_KEY
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['LLM_API_KEY'],
        message: `required when LLM_PROVIDER=${env.LLM_PROVIDER}`,
      });
    }
  });

export type Env = z.output<typeof envSchema>;

export class EnvValidationError extends Error {
  constructor(public readonly issues: { key: string; message: string }[]) {
    super(
      [
        'Invalid environment configuration:',
        ...issues.map((i) => `  - ${i.key}: ${i.message}`),
        '',
        'See .env.example for the full list of variables.',
      ].join('\n'),
    );
    this.name = 'EnvValidationError';
  }
}

/** Validate a process.env-like object. Empty strings count as unset so `FOO=` falls back to the default. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && value !== '') cleaned[key] = value;
  }
  const result = envSchema.safeParse(cleaned);
  if (result.success) return result.data;

  const issues = result.error.issues.map((issue) => {
    const key = String(issue.path[0] ?? '(root)');
    const missing = cleaned[key] === undefined && issue.code === 'invalid_type';
    return { key, message: missing ? 'is required' : issue.message };
  });
  throw new EnvValidationError(issues);
}
