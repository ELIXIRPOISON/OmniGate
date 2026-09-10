/** One row of `audit_logs`. Everything here is already safe to store: no headers, no bodies. */
export interface AuditRecord {
  ts: Date;
  requestId: string;
  apiKeyId: string | null;
  routeId: string | null;
  principal: string | null;
  method: string;
  path: string;
  statusCode: number;
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
}

export interface BufferStats {
  size: number;
  /** Records discarded because the buffer was full since the process started. */
  dropped: number;
  /** Records handed to the writer since the process started. */
  flushed: number;
}

/**
 * Bounded in-memory queue between the request path and the batch writer (docs/08 S7-02).
 * Postgres being slow or down must never slow down or fail a proxied request, so the buffer
 * has a hard cap and drops the oldest records once it is reached.
 */
export class AuditBuffer {
  private records: AuditRecord[] = [];
  private droppedCount = 0;
  private flushedCount = 0;

  constructor(
    private readonly capacity: number,
    private readonly batchSize: number,
  ) {}

  get size(): number {
    return this.records.length;
  }

  get stats(): BufferStats {
    return {
      size: this.records.length,
      dropped: this.droppedCount,
      flushed: this.flushedCount,
    };
  }

  /** Returns the number of records dropped to make room (0 in the normal case). */
  push(record: AuditRecord): number {
    this.records.push(record);
    if (this.records.length <= this.capacity) return 0;
    const overflow = this.records.length - this.capacity;
    this.records.splice(0, overflow);
    this.droppedCount += overflow;
    return overflow;
  }

  /** True once a batch is worth writing without waiting for the timer. */
  get isBatchReady(): boolean {
    return this.records.length >= this.batchSize;
  }

  /** Remove and return up to `batchSize` records, oldest first. */
  take(): AuditRecord[] {
    if (this.records.length === 0) return [];
    const batch = this.records.splice(0, this.batchSize);
    this.flushedCount += batch.length;
    return batch;
  }

  /** Put a failed batch back at the front, respecting the cap (newest records win). */
  requeue(batch: AuditRecord[]): void {
    this.flushedCount -= batch.length;
    this.records.unshift(...batch);
    if (this.records.length > this.capacity) {
      const overflow = this.records.length - this.capacity;
      this.records.splice(0, overflow);
      this.droppedCount += overflow;
    }
  }

  drain(): AuditRecord[] {
    const all = this.records;
    this.records = [];
    this.flushedCount += all.length;
    return all;
  }
}

const IPV4_MAPPED = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

/**
 * `client_ip` is an INET column, so anything that is not an address must become NULL rather than
 * failing the whole batch. Express reports IPv4 peers as ::ffff:a.b.c.d, which is normalised here.
 */
export function normalizeIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const mapped = IPV4_MAPPED.exec(ip);
  const candidate = mapped ? mapped[1] : ip;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(candidate)) {
    return candidate.split('.').every((o) => Number(o) <= 255)
      ? candidate
      : null;
  }
  // Loose IPv6 check: hex groups and colons only, at least one colon.
  return /^[0-9a-f:]+$/i.test(candidate) && candidate.includes(':')
    ? candidate
    : null;
}

export function truncate(
  value: string | null | undefined,
  max: number,
): string | null {
  if (!value) return null;
  return value.length <= max ? value : value.slice(0, max);
}
