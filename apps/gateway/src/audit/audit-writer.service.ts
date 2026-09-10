import {
  Inject,
  Injectable,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  AuditBuffer,
  type AuditRecord,
  type BufferStats,
} from './audit-buffer.js';

export const FLUSH_INTERVAL_MS = 1_000;
export const BATCH_SIZE = 500;
export const BUFFER_CAPACITY = 50_000;
const DROP_WARN_INTERVAL_MS = 30_000;
/** A batch that fails this many times in a row is discarded (poison-pill protection). */
export const MAX_BATCH_ATTEMPTS = 2;

/**
 * Drains the audit buffer into Postgres with one multi-row insert per batch (docs/04 section 3,
 * docs/08 S7-02). Nothing here is awaited by a request: the interceptor only calls `add()`.
 */
@Injectable()
export class AuditWriter implements OnModuleInit, OnApplicationShutdown {
  private readonly buffer = new AuditBuffer(BUFFER_CAPACITY, BATCH_SIZE);
  private timer?: NodeJS.Timeout;
  private flushing = false;
  private lastDropWarn = 0;
  private stopped = false;
  private failedAttempts = 0;

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(AuditWriter.name);
  }

  onModuleInit(): void {
    this.timer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
    this.timer.unref();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    // Best effort: write whatever is still buffered so a graceful restart loses nothing.
    await this.flush(true);
  }

  get stats(): BufferStats {
    return this.buffer.stats;
  }

  add(record: AuditRecord): void {
    if (this.stopped) return;
    const dropped = this.buffer.push(record);
    if (dropped > 0) this.warnDropped(dropped);
    if (this.buffer.isBatchReady) void this.flush();
  }

  /** Exposed for tests and shutdown; safe to call concurrently, one flush runs at a time. */
  async flush(drainAll = false): Promise<number> {
    if (this.flushing) return 0;
    this.flushing = true;
    let written = 0;
    try {
      for (;;) {
        const batch = drainAll ? this.buffer.drain() : this.buffer.take();
        if (batch.length === 0) break;
        try {
          await this.insert(batch);
          written += batch.length;
          this.failedAttempts = 0;
        } catch (err) {
          this.failedAttempts += 1;
          // A batch that fails twice is not a transient outage but bad data: drop it rather than
          // letting one poisoned record block every later write.
          if (this.failedAttempts >= MAX_BATCH_ATTEMPTS) {
            this.failedAttempts = 0;
            this.logger.error(
              { err_message: (err as Error).message, dropped: batch.length },
              'audit batch rejected twice; discarding it',
            );
          } else {
            this.buffer.requeue(batch);
            this.logger.warn(
              {
                err_message: (err as Error).message,
                batch: batch.length,
                buffered: this.buffer.size,
              },
              'audit batch insert failed; records kept for the next flush',
            );
          }
          break;
        }
        if (!drainAll && !this.buffer.isBatchReady) break;
      }
    } finally {
      this.flushing = false;
    }
    return written;
  }

  /** One statement per batch: arrays are expanded server-side by unnest (docs/04 section 3). */
  private async insert(batch: AuditRecord[]): Promise<void> {
    const col = <T>(pick: (r: AuditRecord) => T): T[] => batch.map(pick);
    await this.prisma.$executeRaw`
      INSERT INTO audit_logs (
        ts, request_id, api_key_id, route_id, principal, method, path, status_code,
        latency_ms, upstream_ms, client_ip, user_agent, req_bytes, res_bytes,
        rate_limited, cache_status, anomaly_score, error_type
      )
      SELECT * FROM unnest(
        ${col((r) => r.ts)}::timestamptz[],
        ${col((r) => r.requestId)}::varchar[],
        ${col((r) => r.apiKeyId)}::uuid[],
        ${col((r) => r.routeId)}::uuid[],
        ${col((r) => r.principal)}::varchar[],
        ${col((r) => r.method)}::varchar[],
        ${col((r) => r.path)}::text[],
        ${col((r) => r.statusCode)}::smallint[],
        ${col((r) => r.latencyMs)}::integer[],
        ${col((r) => r.upstreamMs)}::integer[],
        ${col((r) => r.clientIp)}::inet[],
        ${col((r) => r.userAgent)}::varchar[],
        ${col((r) => r.reqBytes)}::integer[],
        ${col((r) => r.resBytes)}::integer[],
        ${col((r) => r.rateLimited)}::boolean[],
        ${col((r) => r.cacheStatus)}::varchar[],
        ${col((r) => r.anomalyScore)}::real[],
        ${col((r) => r.errorType)}::varchar[]
      )`;
  }

  private warnDropped(dropped: number): void {
    const now = Date.now();
    if (now - this.lastDropWarn < DROP_WARN_INTERVAL_MS) return;
    this.lastDropWarn = now;
    this.logger.warn(
      {
        dropped,
        total_dropped: this.buffer.stats.dropped,
        capacity: BUFFER_CAPACITY,
      },
      'audit buffer full; dropping oldest records',
    );
  }

  /** Retention and partition maintenance, run nightly (docs/04 section 3). Idempotent. */
  async maintainPartitions(
    now = new Date(),
  ): Promise<{ created: string[]; dropped: string[] }> {
    const created: string[] = [];
    const dropped: string[] = [];

    // Ensure the current month and the next two exist, so writes never hit a missing partition.
    for (let offset = 0; offset <= 2; offset++) {
      const start = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1),
      );
      const end = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset + 1, 1),
      );
      const name = partitionName(start);
      await this.prisma.$executeRawUnsafe(
        `CREATE TABLE IF NOT EXISTS ${quoteIdent(name)} PARTITION OF audit_logs FOR VALUES FROM ('${isoDate(start)}') TO ('${isoDate(end)}')`,
      );
      created.push(name);
    }

    const cutoff = new Date(
      now.getTime() - this.env.LOG_RETENTION_DAYS * 24 * 3600 * 1000,
    );
    const rows = await this.prisma.$queryRaw<Array<{ table_name: string }>>`
      SELECT c.relname AS table_name
      FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
      JOIN pg_class p ON p.oid = i.inhparent
      WHERE p.relname = 'audit_logs'`;
    for (const { table_name: name } of rows) {
      const month = monthFromPartition(name);
      // Drop only once the whole month is older than the retention window.
      if (month && new Date(Date.UTC(month.year, month.month, 1)) <= cutoff) {
        await this.prisma.$executeRawUnsafe(
          `DROP TABLE IF EXISTS ${quoteIdent(name)}`,
        );
        dropped.push(name);
      }
    }
    if (created.length || dropped.length) {
      this.logger.info(
        { created, dropped, retention_days: this.env.LOG_RETENTION_DAYS },
        'audit partitions maintained',
      );
    }
    return { created, dropped };
  }
}

export function partitionName(start: Date): string {
  return `audit_logs_${start.getUTCFullYear()}_${String(start.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function monthFromPartition(
  name: string,
): { year: number; month: number } | null {
  const m = /^audit_logs_(\d{4})_(\d{2})$/.exec(name);
  if (!m) return null;
  // `month` is the 1-based calendar month. Used as a 0-based index in Date.UTC it yields the
  // partition's exclusive end, which is exactly what the retention comparison needs.
  return { year: Number(m[1]), month: Number(m[2]) };
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Identifiers are generated from dates, never user input, but validate and quote them anyway. */
function quoteIdent(name: string): string {
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`unsafe identifier: ${name}`);
  return `"${name}"`;
}
