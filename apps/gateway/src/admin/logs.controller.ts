import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AdminJwtGuard } from './admin-jwt.guard.js';
import { logsQuery, resolveRange } from './dto.js';
import { validate } from './zod-validation.pipe.js';

type LogsQuery = ReturnType<typeof logsQuery.parse>;

/** Request-level explorer over audit_logs. Capped at 1000 rows per docs/03 section 2. */
@Controller('admin/v1/logs')
@UseGuards(AdminJwtGuard)
export class LogsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(
    @Query(validate(logsQuery)) q: LogsQuery,
  ): Promise<{ items: unknown[]; total: number }> {
    const { from, to } = resolveRange(q, 60);
    const filters: Prisma.Sql[] = [
      Prisma.sql`a.ts >= ${from} AND a.ts < ${to}`,
    ];
    if (q.status !== undefined)
      filters.push(Prisma.sql`a.status_code = ${q.status}`);
    if (q.statusClass) {
      const lo = Number(q.statusClass[0]) * 100;
      filters.push(
        Prisma.sql`a.status_code >= ${lo} AND a.status_code < ${lo + 100}`,
      );
    }
    if (q.routeId) filters.push(Prisma.sql`a.route_id = ${q.routeId}::uuid`);
    if (q.apiKeyId)
      filters.push(Prisma.sql`a.api_key_id = ${q.apiKeyId}::uuid`);
    if (q.requestId) filters.push(Prisma.sql`a.request_id = ${q.requestId}`);
    if (q.minLatencyMs !== undefined)
      filters.push(Prisma.sql`a.latency_ms >= ${q.minLatencyMs}`);
    if (q.rateLimited !== undefined)
      filters.push(Prisma.sql`a.rate_limited = ${q.rateLimited}`);
    if (q.cacheStatus)
      filters.push(Prisma.sql`a.cache_status = ${q.cacheStatus}`);

    const where = Prisma.join(filters, ' AND ');
    const rows = await this.prisma.$queryRaw<Array<Record<string, unknown>>>`
      SELECT a.ts, a.request_id, a.principal, a.method, a.path, a.status_code, a.latency_ms,
             a.upstream_ms, host(a.client_ip) AS client_ip, a.user_agent, a.req_bytes, a.res_bytes,
             a.rate_limited, a.cache_status, a.anomaly_score, a.error_type,
             r.service AS route, k.name AS api_key_name
      FROM audit_logs a
      LEFT JOIN routes r ON r.id = a.route_id::text
      LEFT JOIN api_keys k ON k.id = a.api_key_id::text
      WHERE ${where}
      ORDER BY a.ts DESC
      LIMIT ${q.limit}`;

    const items = rows.map((r) => ({
      ts: r.ts,
      requestId: r.request_id,
      principal: r.principal,
      method: r.method,
      path: r.path,
      status: Number(r.status_code),
      latencyMs: Number(r.latency_ms),
      upstreamMs: r.upstream_ms === null ? null : Number(r.upstream_ms),
      clientIp: r.client_ip,
      userAgent: r.user_agent,
      reqBytes: r.req_bytes === null ? null : Number(r.req_bytes),
      resBytes: r.res_bytes === null ? null : Number(r.res_bytes),
      rateLimited: Boolean(r.rate_limited),
      cacheStatus: r.cache_status,
      anomalyScore: r.anomaly_score === null ? null : Number(r.anomaly_score),
      errorType: r.error_type,
      route: r.route,
      apiKeyName: r.api_key_name,
    }));
    return { items, total: items.length };
  }
}
