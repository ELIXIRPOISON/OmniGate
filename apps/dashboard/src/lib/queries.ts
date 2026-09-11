import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { ResolvedRange } from '@/components/ui/time-range';

/** Shapes returned by the admin API. Kept here so pages import data, not fetch plumbing. */

export interface Overview {
  from: string;
  to: string;
  requests: number;
  errorRate: number;
  p50: number;
  p95: number;
  rateLimited: number;
  cacheHitRatio: number | null;
  anomalies: number;
  blocked: number;
}

export interface TimeseriesPoint {
  ts: string;
  requests: number;
  errors: number;
  clientErrors: number;
  ok: number;
  latencyP50: number;
  latencyP95: number;
  rateLimited: number;
  cacheHits: number;
}

export interface BreakdownItem {
  key: string;
  requests: number;
  errors: number;
  p95: number | null;
}

export interface AnomalyRow {
  id: string;
  requestId: string;
  createdAt: string;
  method: string;
  path: string;
  heuristicScore: number;
  llmScore: number | null;
  verdict: 'benign' | 'suspicious' | 'malicious' | null;
  categories: string[];
  blocked: boolean;
  reviewed: boolean;
  reviewLabel: 'true_positive' | 'false_positive' | null;
  clientIp: string | null;
  apiKeyId: string | null;
  routeId: string | null;
  apiKey?: { name: string; prefix: string } | null;
  route?: { service: string } | null;
}

export interface LogRow {
  ts: string;
  requestId: string;
  principal: string | null;
  method: string;
  path: string;
  status: number;
  latencyMs: number;
  upstreamMs: number | null;
  clientIp: string | null;
  userAgent: string | null;
  reqBytes: number | null;
  resBytes: number | null;
  rateLimited: boolean;
  cacheStatus: string | null;
  anomalyScore: number | null;
  errorType: string | null;
  route: string | null;
  apiKeyName: string | null;
}

export interface ApiKeyRow {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  status: 'active' | 'revoked';
  policyId: string | null;
  policyName: string | null;
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export interface RouteRow {
  id: string;
  service: string;
  upstream: string;
  stripPrefix: boolean;
  methods: string[];
  authRequired: boolean;
  scopes: string[];
  policyId: string | null;
  cacheTtlSeconds: number;
  anomalyMode: 'off' | 'async' | 'sync';
  timeoutMs: number;
  enabled: boolean;
  policy?: { name: string; windowSeconds: number; maxRequests: number } | null;
}

export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

const iso = (d: Date) => d.toISOString();

/** Ten seconds, per the dashboard spec, and only while the tab is visible. */
export const LIVE_INTERVAL_MS = 10_000;

export function useOverview(range: ResolvedRange, live: boolean) {
  return useQuery({
    queryKey: ['overview', range.preset.id, range.from.getTime()],
    queryFn: () =>
      api<Overview>('/admin/v1/metrics/overview', {
        query: { from: iso(range.from), to: iso(range.to) },
      }),
    refetchInterval: live ? LIVE_INTERVAL_MS : false,
  });
}

/** The window before this one, so every tile can show a change rather than a bare number. */
export function usePreviousOverview(range: ResolvedRange, live: boolean) {
  return useQuery({
    queryKey: ['overview-prev', range.preset.id, range.previousFrom.getTime()],
    queryFn: () =>
      api<Overview>('/admin/v1/metrics/overview', {
        query: { from: iso(range.previousFrom), to: iso(range.previousTo) },
      }),
    refetchInterval: live ? LIVE_INTERVAL_MS : false,
  });
}

const BUCKET_MS = { '1m': 60_000, '5m': 300_000, '1h': 3_600_000 } as const;

const emptyPoint = (ts: string): TimeseriesPoint => ({
  ts,
  requests: 0,
  errors: 0,
  clientErrors: 0,
  ok: 0,
  latencyP50: 0,
  latencyP95: 0,
  rateLimited: 0,
  cacheHits: 0,
});

/**
 * The API groups by bucket, so a quiet minute simply has no row. Plotting that directly would draw a
 * line between distant points and imply traffic that never happened, so the gaps are filled with
 * zeroes across the whole window before anything is charted.
 */
export function fillBuckets(points: TimeseriesPoint[], range: ResolvedRange): TimeseriesPoint[] {
  const step = BUCKET_MS[range.preset.bucket];
  const byBucket = new Map<number, TimeseriesPoint>();
  for (const point of points) {
    byBucket.set(Math.floor(new Date(point.ts).getTime() / step) * step, point);
  }

  const start = Math.floor(range.from.getTime() / step) * step;
  const end = Math.floor(range.to.getTime() / step) * step;
  const filled: TimeseriesPoint[] = [];
  for (let t = start; t <= end; t += step) {
    filled.push(byBucket.get(t) ?? emptyPoint(new Date(t).toISOString()));
  }
  // A very wide window with a fine bucket could still be long; the API caps at 2000 points.
  return filled.length > 2_000 ? filled.slice(filled.length - 2_000) : filled;
}

export function useTimeseries(range: ResolvedRange, live: boolean) {
  return useQuery({
    queryKey: ['timeseries', range.preset.id, range.from.getTime()],
    queryFn: async () => {
      const result = await api<{ points: TimeseriesPoint[] }>('/admin/v1/metrics/timeseries', {
        query: { from: iso(range.from), to: iso(range.to), bucket: range.preset.bucket },
      });
      return { points: fillBuckets(result.points, range) };
    },
    refetchInterval: live ? LIVE_INTERVAL_MS : false,
  });
}

export function useBreakdown(
  range: ResolvedRange,
  by: 'route' | 'api_key' | 'status' | 'client_ip',
  live: boolean,
  limit = 8,
) {
  return useQuery({
    queryKey: ['breakdown', by, range.preset.id, range.from.getTime(), limit],
    queryFn: () =>
      api<{ by: string; sampledLatency: boolean; items: BreakdownItem[] }>(
        '/admin/v1/metrics/breakdown',
        { query: { from: iso(range.from), to: iso(range.to), by, limit } },
      ),
    refetchInterval: live ? LIVE_INTERVAL_MS : false,
  });
}

export function useAnomalies(query: Record<string, string | number | undefined>, live = false) {
  return useQuery({
    queryKey: ['anomalies', query],
    queryFn: () => api<Page<AnomalyRow>>('/admin/v1/anomalies', { query }),
    refetchInterval: live ? LIVE_INTERVAL_MS : false,
  });
}

export function useLogs(query: Record<string, string | number | boolean | undefined>, live = false) {
  return useQuery({
    queryKey: ['logs', query],
    queryFn: () => api<{ items: LogRow[]; total: number }>('/admin/v1/logs', { query }),
    refetchInterval: live ? LIVE_INTERVAL_MS : false,
  });
}

export function useApiKeys(query: Record<string, string | number | undefined> = {}) {
  return useQuery({
    queryKey: ['api-keys', query],
    queryFn: () => api<Page<ApiKeyRow>>('/admin/v1/api-keys', { query }),
  });
}

export function useRoutes() {
  return useQuery({
    queryKey: ['routes'],
    queryFn: () => api<Page<RouteRow>>('/admin/v1/routes', { query: { pageSize: 200 } }),
  });
}
