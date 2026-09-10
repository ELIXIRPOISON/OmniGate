import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AdminJwtGuard } from './admin-jwt.guard.js';
import {
  breakdownQuery,
  rangeQuery,
  resolveRange,
  timeseriesQuery,
} from './dto.js';
import { validate } from './zod-validation.pipe.js';

export interface Overview {
  from: Date;
  to: Date;
  requests: number;
  errorRate: number;
  p50: number;
  p95: number;
  rateLimited: number;
  cacheHitRatio: number | null;
  anomalies: number;
  blocked: number;
}

const BUCKETS = {
  '1m': '1 minute',
  '5m': '5 minutes',
  '1h': '1 hour',
} as const;
/** Keeps a wide range from returning thousands of points to the dashboard (docs/07 section 4). */
const MAX_POINTS = 2_000;
/** Above this many requests in the window, per-group latency is taken from a sample. */
export const LATENCY_SAMPLE_THRESHOLD = 200_000;
export const LATENCY_SAMPLE_DIVISOR = 10;

const n = (v: unknown): number =>
  v === null || v === undefined ? 0 : Number(v);

@Controller('admin/v1/metrics')
@UseGuards(AdminJwtGuard)
export class MetricsController {
  constructor(private readonly prisma: PrismaService) {}

  /** SQL from docs/07 section 4, plus the two anomaly counters the dashboard shows. */
  @Get('overview')
  async overview(
    @Query(validate(rangeQuery)) q: { from?: Date; to?: Date },
  ): Promise<Overview> {
    const { from, to } = resolveRange(q);
    const [rows, anomalies] = await Promise.all([
      this.prisma.$queryRaw<Array<Record<string, unknown>>>`
        SELECT count(*)                                                        AS requests,
               avg((status_code >= 500)::int)                                  AS error_rate,
               percentile_cont(0.5)  WITHIN GROUP (ORDER BY latency_ms)        AS p50,
               percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)        AS p95,
               count(*) FILTER (WHERE rate_limited)                            AS rate_limited,
               count(*) FILTER (WHERE cache_status = 'HIT')::float
                 / NULLIF(count(*) FILTER (WHERE cache_status IN ('HIT','MISS')), 0) AS cache_hit_ratio
        FROM audit_logs WHERE ts >= ${from} AND ts < ${to}`,
      this.prisma.anomalyEvent.groupBy({
        by: ['blocked'],
        where: { createdAt: { gte: from, lt: to } },
        _count: { _all: true },
      }),
    ]);
    const row = rows[0] ?? {};
    return {
      from,
      to,
      requests: n(row.requests),
      errorRate: Math.round(n(row.error_rate) * 10_000) / 10_000,
      p50: Math.round(n(row.p50)),
      p95: Math.round(n(row.p95)),
      rateLimited: n(row.rate_limited),
      cacheHitRatio:
        row.cache_hit_ratio === null
          ? null
          : Math.round(n(row.cache_hit_ratio) * 10_000) / 10_000,
      anomalies: anomalies.reduce((sum, g) => sum + g._count._all, 0),
      blocked: anomalies
        .filter((g) => g.blocked)
        .reduce((sum, g) => sum + g._count._all, 0),
    };
  }

  @Get('timeseries')
  async timeseries(
    @Query(validate(timeseriesQuery))
    q: {
      from?: Date;
      to?: Date;
      bucket: '1m' | '5m' | '1h';
      metric: string;
      apiKeyId?: string;
    },
  ): Promise<{
    bucket: string;
    metric: string;
    points: Array<Record<string, unknown>>;
  }> {
    const { from, to } = resolveRange(q);
    const interval = BUCKETS[q.bucket];
    const keyFilter = q.apiKeyId
      ? Prisma.sql`AND api_key_id = ${q.apiKeyId}::uuid`
      : Prisma.empty;

    const rows = await this.prisma.$queryRaw<Array<Record<string, unknown>>>`
      SELECT date_bin(${interval}::interval, ts, TIMESTAMPTZ '2000-01-01') AS bucket,
             count(*)                                                       AS requests,
             count(*) FILTER (WHERE status_code >= 500)                      AS errors,
             count(*) FILTER (WHERE status_code >= 400 AND status_code < 500) AS client_errors,
             count(*) FILTER (WHERE status_code < 400)                       AS ok,
             percentile_cont(0.5)  WITHIN GROUP (ORDER BY latency_ms)        AS latency_p50,
             percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)        AS latency_p95,
             count(*) FILTER (WHERE rate_limited)                            AS rate_limited,
             count(*) FILTER (WHERE cache_status = 'HIT')                    AS cache_hits
      FROM audit_logs
      WHERE ts >= ${from} AND ts < ${to} ${keyFilter}
      GROUP BY 1 ORDER BY 1 LIMIT ${MAX_POINTS}`;

    const points = rows.map((r) => ({
      ts: r.bucket,
      requests: n(r.requests),
      errors: n(r.errors),
      clientErrors: n(r.client_errors),
      ok: n(r.ok),
      latencyP50: Math.round(n(r.latency_p50)),
      latencyP95: Math.round(n(r.latency_p95)),
      rateLimited: n(r.rate_limited),
      cacheHits: n(r.cache_hits),
    }));
    return { bucket: q.bucket, metric: q.metric, points };
  }

  /**
   * Two cheap statements instead of one expensive one. Counting is a fast grouped scan, but an exact
   * per-group percentile over a wide window costs about 900 ms on a million rows because every group
   * must be sorted. Latency is therefore taken from a deterministic 10 % sample once the window is
   * large, which is accurate enough for a top-N table and keeps the endpoint an order of magnitude
   * inside the 500 ms budget. Small windows stay exact.
   */
  @Get('breakdown')
  async breakdown(
    @Query(validate(breakdownQuery))
    q: {
      from?: Date;
      to?: Date;
      by: 'route' | 'api_key' | 'status' | 'client_ip';
      limit: number;
    },
  ): Promise<{
    by: string;
    sampledLatency: boolean;
    items: Array<Record<string, unknown>>;
  }> {
    const { from, to } = resolveRange(q);
    const { group, label, join } = breakdownShape(q.by);

    const counts = await this.prisma.$queryRaw<Array<Record<string, unknown>>>`
      WITH agg AS (
        SELECT ${group}                                      AS group_key,
               count(*)                                      AS requests,
               count(*) FILTER (WHERE status_code >= 500)     AS errors
        FROM audit_logs
        WHERE ts >= ${from} AND ts < ${to}
        GROUP BY 1
        ORDER BY 2 DESC
        LIMIT ${q.limit}
      )
      SELECT agg.group_key, ${label} AS key, agg.requests, agg.errors
      FROM agg ${join}
      ORDER BY agg.requests DESC`;

    const total = counts.reduce((sum, r) => sum + n(r.requests), 0);
    const divisor =
      total > LATENCY_SAMPLE_THRESHOLD ? LATENCY_SAMPLE_DIVISOR : 1;
    const latencies = await this.prisma.$queryRaw<
      Array<Record<string, unknown>>
    >`
      SELECT ${group}                                                  AS group_key,
             percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)   AS p95
      FROM audit_logs
      WHERE ts >= ${from} AND ts < ${to} AND id % ${divisor} = 0
      GROUP BY 1`;
    const p95ByGroup = new Map(
      latencies.map((r) => [String(r.group_key), Math.round(n(r.p95))]),
    );

    return {
      by: q.by,
      sampledLatency: divisor > 1,
      items: counts.map((r) => ({
        key: r.key === null ? '(none)' : String(r.key),
        requests: n(r.requests),
        errors: n(r.errors),
        p95: p95ByGroup.get(String(r.group_key)) ?? null,
      })),
    };
  }
}

/**
 * Only these four shapes are reachable and nothing is interpolated from user input. Each grouping
 * aggregates on a raw column so the scan stays index-friendly; the label join runs over the
 * already-reduced result.
 */
function breakdownShape(by: 'route' | 'api_key' | 'status' | 'client_ip'): {
  group: Prisma.Sql;
  label: Prisma.Sql;
  join: Prisma.Sql;
} {
  switch (by) {
    case 'route':
      return {
        group: Prisma.sql`route_id`,
        label: Prisma.sql`coalesce(r.service, '(unrouted)')`,
        join: Prisma.sql`LEFT JOIN routes r ON r.id = agg.group_key::text`,
      };
    case 'api_key':
      return {
        group: Prisma.sql`api_key_id`,
        label: Prisma.sql`coalesce(k.name, '(anonymous)')`,
        join: Prisma.sql`LEFT JOIN api_keys k ON k.id = agg.group_key::text`,
      };
    case 'status':
      return {
        group: Prisma.sql`status_code`,
        label: Prisma.sql`agg.group_key::text`,
        join: Prisma.empty,
      };
    case 'client_ip':
      return {
        group: Prisma.sql`client_ip`,
        label: Prisma.sql`host(agg.group_key)`,
        join: Prisma.empty,
      };
  }
}
