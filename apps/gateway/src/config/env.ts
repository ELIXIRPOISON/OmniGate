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
    LLM_PROVIDER: z
      .enum(['openai', 'anthropic', 'local', 'fake'])
      .default('openai'),
    LLM_MODEL: z.string().min(1).optional(),
    LLM_API_KEY: z.string().min(1).optional(),
    LLM_DAILY_CALL_CAP: int().nonnegative().default(20_000),

    WORKER_INLINE: bool().default(true),
    LOG_RETENTION_DAYS: int().positive().default(30),
    EXPOSE_ANOMALY_SCORE: bool().default(false),
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
