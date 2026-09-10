import { parseArgs } from 'node:util';
import { performance } from 'node:perf_hooks';
import { PrismaPg } from '@prisma/adapter-pg';
import { loadDotenv } from '../config/dotenv.js';
import { loadEnv } from '../config/env.js';
import { PrismaClient } from '../generated/prisma/client.js';

/**
 * Fills audit_logs with synthetic traffic so the metrics endpoints can be measured against a
 * realistic table (docs/08 S7-05: under 500 ms for a 24 hour range over a million rows).
 *
 *   pnpm --filter @omnigate/gateway seed:audit -- --rows 1000000 --hours 24
 *   pnpm --filter @omnigate/gateway seed:audit -- --measure-only
 */

const PATHS = [
  '/api/orders/v1/orders',
  '/api/orders/v1/orders/42',
  '/api/catalog/items',
  '/api/mock/items',
  '/api/mock/echo',
];
const METHODS = ['GET', 'GET', 'GET', 'GET', 'POST', 'PUT', 'DELETE'];
const AGENTS = [
  'Mozilla/5.0 (Macintosh) Chrome/128',
  'okhttp/4.12.0',
  'python-requests/2.32.3',
  'omnigate-sdk/1.4.2',
];

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function main(): Promise<void> {
  loadDotenv();
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((a) => a !== '--'),
    options: {
      rows: { type: 'string' },
      hours: { type: 'string' },
      batch: { type: 'string' },
      'measure-only': { type: 'boolean' },
      truncate: { type: 'boolean' },
    },
  });

  const env = loadEnv();
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
  });
  const rows = Number(values.rows ?? 1_000_000);
  const hours = Number(values.hours ?? 24);
  const batchSize = Number(values.batch ?? 5_000);

  try {
    if (values.truncate) {
      await prisma.$executeRawUnsafe('TRUNCATE audit_logs');
      console.log('audit_logs truncated');
    }

    if (!values['measure-only']) {
      // Route and key ids are read from the tables so the metrics joins have something to match.
      const [routeIds, keyIds] = await Promise.all([
        prisma.route
          .findMany({ select: { id: true } })
          .then((r) => r.map((x) => x.id)),
        prisma.apiKey
          .findMany({ select: { id: true } })
          .then((k) => k.map((x) => x.id)),
      ]);
      console.log(
        `seeding ${rows.toLocaleString('en-US')} rows over the last ${hours} h ` +
          `(${routeIds.length} route(s), ${keyIds.length} key(s))`,
      );

      const rand = rng(20260910);
      const now = Date.now();
      const spanMs = hours * 3_600_000;
      const startedAt = performance.now();
      let written = 0;

      while (written < rows) {
        const n = Math.min(batchSize, rows - written);
        const ts: Date[] = [];
        const requestId: string[] = [];
        const apiKeyId: (string | null)[] = [];
        const routeId: (string | null)[] = [];
        const principal: string[] = [];
        const method: string[] = [];
        const path: string[] = [];
        const status: number[] = [];
        const latency: number[] = [];
        const upstream: number[] = [];
        const ip: string[] = [];
        const agent: string[] = [];
        const rateLimited: boolean[] = [];
        const cacheStatus: (string | null)[] = [];
        const anomaly: (number | null)[] = [];
        const errorType: (string | null)[] = [];

        for (let i = 0; i < n; i++) {
          const r = rand();
          const keyId =
            keyIds.length && r < 0.7
              ? keyIds[Math.floor(rand() * keyIds.length)]
              : null;
          // 1 % server errors, 4 % client errors, 3 % rate limited: enough to exercise every filter.
          const roll = rand();
          const code =
            roll < 0.01 ? 502 : roll < 0.04 ? 404 : roll < 0.07 ? 429 : 200;
          const cache = rand();
          ts.push(new Date(now - Math.floor(rand() * spanMs)));
          requestId.push(`seed-${written + i}`);
          apiKeyId.push(keyId);
          routeId.push(
            routeIds.length
              ? routeIds[Math.floor(rand() * routeIds.length)]
              : null,
          );
          principal.push(
            keyId
              ? `api_key:${keyId}`
              : `anon:203.0.113.${Math.floor(rand() * 250) + 1}`,
          );
          method.push(METHODS[Math.floor(rand() * METHODS.length)]);
          path.push(PATHS[Math.floor(rand() * PATHS.length)]);
          status.push(code);
          latency.push(
            Math.max(
              1,
              Math.round(3 + rand() * 40 + (rand() < 0.02 ? 400 : 0)),
            ),
          );
          upstream.push(Math.max(0, Math.round(rand() * 30)));
          ip.push(`203.0.113.${Math.floor(rand() * 250) + 1}`);
          agent.push(AGENTS[Math.floor(rand() * AGENTS.length)]);
          rateLimited.push(code === 429);
          cacheStatus.push(cache < 0.4 ? 'HIT' : cache < 0.7 ? 'MISS' : null);
          anomaly.push(rand() < 0.1 ? Math.round(rand() * 1000) / 1000 : null);
          errorType.push(
            code === 429
              ? 'rate-limited'
              : code === 502
                ? 'bad-gateway'
                : code === 404
                  ? 'route-not-found'
                  : null,
          );
        }

        await prisma.$executeRaw`
          INSERT INTO audit_logs (
            ts, request_id, api_key_id, route_id, principal, method, path, status_code,
            latency_ms, upstream_ms, client_ip, user_agent, rate_limited, cache_status,
            anomaly_score, error_type
          )
          SELECT * FROM unnest(
            ${ts}::timestamptz[], ${requestId}::varchar[], ${apiKeyId}::uuid[], ${routeId}::uuid[],
            ${principal}::varchar[], ${method}::varchar[], ${path}::text[], ${status}::smallint[],
            ${latency}::integer[], ${upstream}::integer[], ${ip}::inet[], ${agent}::varchar[],
            ${rateLimited}::boolean[], ${cacheStatus}::varchar[], ${anomaly}::real[], ${errorType}::varchar[]
          )`;
        written += n;
        if (written % 100_000 === 0 || written === rows) {
          const rate = Math.round(
            written / ((performance.now() - startedAt) / 1000),
          );
          console.log(
            `  ${written.toLocaleString('en-US')} rows (${rate.toLocaleString('en-US')}/s)`,
          );
        }
      }
      await prisma.$executeRawUnsafe('ANALYZE audit_logs');
      console.log(
        `seeded in ${((performance.now() - startedAt) / 1000).toFixed(1)} s`,
      );
    }

    // ---- measure the queries the dashboard actually issues ----
    const [{ c }] = await prisma.$queryRaw<
      Array<{ c: bigint }>
    >`SELECT count(*)::bigint AS c FROM audit_logs`;
    const from = new Date(Date.now() - hours * 3_600_000);
    const to = new Date();
    console.log(
      `\nmeasuring against ${Number(c).toLocaleString('en-US')} rows, window ${hours} h`,
    );

    const timed = async (
      label: string,
      run: () => Promise<unknown>,
    ): Promise<number> => {
      await run(); // warm the plan and the cache
      const started = performance.now();
      await run();
      const ms = performance.now() - started;
      console.log(
        `  ${label.padEnd(22)} ${ms.toFixed(0).padStart(5)} ms  ${ms < 500 ? 'ok' : 'OVER TARGET'}`,
      );
      return ms;
    };

    await timed(
      'overview',
      () => prisma.$queryRaw`
      SELECT count(*) AS requests, avg((status_code >= 500)::int) AS error_rate,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms) AS p50,
             percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95,
             count(*) FILTER (WHERE rate_limited) AS rate_limited,
             count(*) FILTER (WHERE cache_status = 'HIT')::float
               / NULLIF(count(*) FILTER (WHERE cache_status IN ('HIT','MISS')), 0) AS cache_hit_ratio
      FROM audit_logs WHERE ts >= ${from} AND ts < ${to}`,
    );

    await timed(
      'timeseries 1m',
      () => prisma.$queryRaw`
      SELECT date_bin('1 minute'::interval, ts, TIMESTAMPTZ '2000-01-01') AS bucket,
             count(*) AS requests, count(*) FILTER (WHERE status_code >= 500) AS errors,
             percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95
      FROM audit_logs WHERE ts >= ${from} AND ts < ${to} GROUP BY 1 ORDER BY 1 LIMIT 2000`,
    );

    await timed(
      'breakdown by route',
      () => prisma.$queryRaw`
      WITH agg AS (
        SELECT route_id AS group_key, count(*) AS requests,
               count(*) FILTER (WHERE status_code >= 500) AS errors
        FROM audit_logs WHERE ts >= ${from} AND ts < ${to}
        GROUP BY 1 ORDER BY 2 DESC LIMIT 10
      )
      SELECT agg.group_key, coalesce(r.service, '(unrouted)') AS key, agg.requests, agg.errors
      FROM agg LEFT JOIN routes r ON r.id = agg.group_key::text ORDER BY agg.requests DESC`,
    );

    await timed(
      'breakdown latency p95',
      () => prisma.$queryRaw`
      SELECT route_id AS group_key, percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95
      FROM audit_logs WHERE ts >= ${from} AND ts < ${to} AND id % 10 = 0 GROUP BY 1`,
    );

    await timed(
      'logs (100 newest)',
      () => prisma.$queryRaw`
      SELECT a.ts, a.request_id, a.status_code, a.latency_ms FROM audit_logs a
      WHERE a.ts >= ${from} AND a.ts < ${to} ORDER BY a.ts DESC LIMIT 100`,
    );

    await timed(
      'logs (5xx filtered)',
      () => prisma.$queryRaw`
      SELECT a.ts, a.request_id, a.status_code FROM audit_logs a
      WHERE a.ts >= ${from} AND a.ts < ${to} AND a.status_code >= 500 ORDER BY a.ts DESC LIMIT 100`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

await main();
