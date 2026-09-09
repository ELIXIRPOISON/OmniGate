import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

/** One entry under `routes:` in routes.yaml. Mirrors the Route row in docs/04 and the yaml schema in docs/03. */
export const routeSchema = z.object({
  service: z
    .string()
    .regex(
      /^[a-z0-9][a-z0-9-]{0,62}$/,
      'lowercase letters, digits and hyphens only',
    ),
  upstream: z.url({ protocol: /^https?$/ }),
  strip_prefix: z.boolean().default(true),
  methods: z
    .array(z.string().min(1))
    .min(1)
    .transform((m) => m.map((x) => x.toUpperCase()))
    .default(['*']),
  auth_required: z.boolean().default(true),
  scopes: z.array(z.string().min(1)).default([]),
  rate_limit: z
    .object({
      window_seconds: z.number().int().positive(),
      max_requests: z.number().int().positive(),
    })
    .optional(),
  cache_ttl_seconds: z.number().int().min(0).default(0),
  /** Include the authenticated principal in the cache key. Defaults to CACHE_DEFAULT_VARY_ON_PRINCIPAL. */
  cache_vary_on_principal: z.boolean().optional(),
  anomaly_mode: z.enum(['off', 'async', 'sync']).default('async'),
  /** Block obvious injection payloads on the heuristic score alone, without waiting for the LLM. */
  block_on_heuristic: z.boolean().default(false),
  timeout_ms: z.number().int().positive().optional(),
  enabled: z.boolean().default(true),
});

export const routesFileSchema = z
  .object({ routes: z.array(routeSchema).default([]) })
  .superRefine((file, ctx) => {
    const seen = new Set<string>();
    file.routes.forEach((route, index) => {
      if (seen.has(route.service)) {
        ctx.addIssue({
          code: 'custom',
          path: ['routes', index, 'service'],
          message: `duplicate service "${route.service}"`,
        });
      }
      seen.add(route.service);
    });
  });

type ParsedRoute = z.output<typeof routeSchema>;
/** A route as used at runtime: every default resolved, timeout always present. */
export type RouteConfig = Omit<ParsedRoute, 'timeout_ms'> & {
  timeout_ms: number;
};

export class RoutesValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoutesValidationError';
  }
}

export interface LoadRoutesOptions {
  /** Source for `${VAR}` placeholders. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Used when a route omits `timeout_ms`. */
  defaultTimeoutMs?: number;
}

const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/** Expands `${VAR}` and `${VAR:-default}` so one routes file works on a laptop and inside compose. */
export function interpolateEnv(text: string, env: NodeJS.ProcessEnv): string {
  return text.replace(
    PLACEHOLDER,
    (_match, name: string, fallback?: string) => {
      const value = env[name];
      if (value !== undefined && value !== '') return value;
      if (fallback !== undefined) return fallback;
      throw new RoutesValidationError(
        `routes file references \${${name}} but it is not set and has no default`,
      );
    },
  );
}

export function parseRoutes(
  text: string,
  opts: LoadRoutesOptions = {},
): RouteConfig[] {
  const env = opts.env ?? process.env;
  let doc: unknown;
  try {
    doc = parseYaml(interpolateEnv(text, env));
  } catch (err) {
    if (err instanceof RoutesValidationError) throw err;
    throw new RoutesValidationError(
      `routes file is not valid YAML: ${(err as Error).message}`,
    );
  }

  const result = routesFileSchema.safeParse(doc ?? {});
  if (!result.success) {
    const lines = result.error.issues.map(
      (issue) =>
        `  - ${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`,
    );
    throw new RoutesValidationError(
      ['Invalid routes configuration:', ...lines].join('\n'),
    );
  }

  const defaultTimeout = opts.defaultTimeoutMs ?? 30_000;
  return result.data.routes
    .filter((route) => route.enabled)
    .map((route) => ({
      ...route,
      timeout_ms: route.timeout_ms ?? defaultTimeout,
    }));
}

export function loadRoutesFile(
  path: string,
  opts?: LoadRoutesOptions,
): RouteConfig[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? (err as Error).message;
    throw new RoutesValidationError(
      `cannot read routes file "${path}" (${code})`,
    );
  }
  return parseRoutes(text, opts);
}
