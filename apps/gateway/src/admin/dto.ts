import { isIP } from 'node:net';
import { z } from 'zod';
import { Problems } from '../common/problem/problem.js';

/** Shared list envelope for every admin collection (docs/03 section 2). */
export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export const pageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

export const loginBody = z.object({
  email: z.email(),
  password: z.string().min(1).max(512),
});

const scopes = z.array(z.string().min(1).max(64)).max(32).default([]);

export const createApiKeyBody = z.object({
  name: z.string().min(1).max(120),
  scopes,
  policyId: z.uuid().nullish(),
  expiresAt: z.coerce.date().nullish(),
});

export const patchApiKeyBody = z
  .object({
    name: z.string().min(1).max(120).optional(),
    scopes: z.array(z.string().min(1).max(64)).max(32).optional(),
    policyId: z.uuid().nullish(),
    status: z.enum(['active', 'revoked']).optional(),
    expiresAt: z.coerce.date().nullish(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'no fields to update' });

export const apiKeyQuery = pageQuery.extend({
  status: z.enum(['active', 'revoked']).optional(),
  q: z.string().min(1).max(120).optional(),
});

/**
 * SSRF guard (T11): an operator-supplied upstream must be http(s) and must not point at a private
 * or link-local address unless the deployment explicitly allows it.
 */
export function upstreamIssue(
  upstream: string,
  allowPrivate: boolean,
): string | null {
  let url: URL;
  try {
    url = new URL(upstream);
  } catch {
    return 'upstream must be an absolute http(s) URL';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    return 'upstream must use http or https';
  if (allowPrivate) return null;

  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (/^(localhost|.*\.local|.*\.internal)$/i.test(host))
    return 'upstream host is not routable in production';
  const version = isIP(host);
  if (version === 0) return null; // a DNS name: resolved at request time, not our call here
  if (version === 4) {
    const [a, b] = host.split('.').map(Number);
    const isPrivate =
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127);
    return isPrivate
      ? 'upstream points at a private or link-local address'
      : null;
  }
  const lower = host.toLowerCase();
  const isPrivateV6 =
    lower === '::1' ||
    lower.startsWith('fc') ||
    lower.startsWith('fd') ||
    lower.startsWith('fe80');
  return isPrivateV6
    ? 'upstream points at a private or link-local address'
    : null;
}

const routeShape = {
  service: z
    .string()
    .regex(
      /^[a-z0-9][a-z0-9-]{0,62}$/,
      'lowercase letters, digits and hyphens only',
    ),
  upstream: z.string().min(1).max(2_048),
  stripPrefix: z.boolean().default(true),
  methods: z.array(z.string().min(1).max(10)).min(1).default(['*']),
  authRequired: z.boolean().default(true),
  scopes,
  policyId: z.uuid().nullish(),
  cacheTtlSeconds: z.number().int().min(0).max(86_400).default(0),
  anomalyMode: z.enum(['off', 'async', 'sync']).default('async'),
  timeoutMs: z.number().int().min(100).max(600_000).default(30_000),
  enabled: z.boolean().default(true),
};

export const createRouteBody = z.object(routeShape);
export const patchRouteBody = z
  .object({
    ...routeShape,
    service: routeShape.service.optional(),
    upstream: routeShape.upstream.optional(),
    stripPrefix: z.boolean().optional(),
    methods: z.array(z.string().min(1).max(10)).min(1).optional(),
    authRequired: z.boolean().optional(),
    scopes: z.array(z.string().min(1).max(64)).max(32).optional(),
    cacheTtlSeconds: z.number().int().min(0).max(86_400).optional(),
    anomalyMode: z.enum(['off', 'async', 'sync']).optional(),
    timeoutMs: z.number().int().min(100).max(600_000).optional(),
    enabled: z.boolean().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'no fields to update' });

export const policyBody = z.object({
  name: z.string().min(1).max(120),
  windowSeconds: z.number().int().min(1).max(86_400),
  maxRequests: z.number().int().min(1).max(10_000_000),
});
export const patchPolicyBody = policyBody
  .partial()
  .refine((b) => Object.keys(b).length > 0, {
    message: 'no fields to update',
  });

/** Metrics windows default to the last hour (docs/03 section 2). */
export const rangeQuery = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export const timeseriesQuery = rangeQuery.extend({
  bucket: z.enum(['1m', '5m', '1h']).default('1m'),
  metric: z
    .enum([
      'requests',
      'errors',
      'latency_p95',
      'latency_p50',
      'rate_limited',
      'cache_hits',
      'status_mix',
    ])
    .default('requests'),
  apiKeyId: z.uuid().optional(),
});

export const breakdownQuery = rangeQuery.extend({
  by: z.enum(['route', 'api_key', 'status', 'client_ip']).default('route'),
  limit: z.coerce.number().int().min(1).max(100).default(10),
});

export const anomalyQuery = pageQuery.extend({
  minScore: z.coerce.number().min(0).max(1).optional(),
  verdict: z.enum(['benign', 'suspicious', 'malicious']).optional(),
  apiKeyId: z.uuid().optional(),
  routeId: z.uuid().optional(),
  requestId: z.string().min(1).max(64).optional(),
  reviewed: z.stringbool().optional(),
  blocked: z.stringbool().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export const reviewBody = z.object({
  reviewed: z.boolean().default(true),
  label: z.enum(['true_positive', 'false_positive']),
});

export const throttleBody = z.object({
  seconds: z.number().int().min(1).max(86_400).default(600),
});

export const logsQuery = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  status: z.coerce.number().int().min(100).max(599).optional(),
  statusClass: z.enum(['2xx', '3xx', '4xx', '5xx']).optional(),
  routeId: z.uuid().optional(),
  apiKeyId: z.uuid().optional(),
  requestId: z.string().min(1).max(64).optional(),
  minLatencyMs: z.coerce.number().int().min(0).optional(),
  rateLimited: z.stringbool().optional(),
  cacheStatus: z.enum(['HIT', 'MISS', 'BYPASS']).optional(),
  limit: z.coerce.number().int().min(1).max(1_000).default(100),
});

/** Windows default to the last hour and are clamped so one query cannot scan the whole table. */
export function resolveRange(
  input: { from?: Date; to?: Date },
  defaultMinutes = 60,
): { from: Date; to: Date } {
  const to = input.to ?? new Date();
  const from = input.from ?? new Date(to.getTime() - defaultMinutes * 60_000);
  if (from >= to) throw Problems.badRequest('from must be before to');
  return { from, to };
}
