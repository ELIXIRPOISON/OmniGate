import {
  AuditBuffer,
  type AuditRecord,
  normalizeIp,
  truncate,
} from './audit-buffer.js';
import { errorSlug } from './audit.middleware.js';
import { monthFromPartition, partitionName } from './audit-writer.service.js';

const record = (n: number): AuditRecord => ({
  ts: new Date(1_800_000_000_000 + n),
  requestId: `r${n}`,
  apiKeyId: null,
  routeId: null,
  principal: 'anon:127.0.0.1',
  method: 'GET',
  path: '/api/mock/items',
  statusCode: 200,
  latencyMs: n,
  upstreamMs: null,
  clientIp: '127.0.0.1',
  userAgent: null,
  reqBytes: null,
  resBytes: null,
  rateLimited: false,
  cacheStatus: null,
  anomalyScore: null,
  errorType: null,
});

describe('AuditBuffer', () => {
  it('batches once the batch size is reached and hands out oldest first', () => {
    const buffer = new AuditBuffer(100, 3);
    expect(buffer.isBatchReady).toBe(false);
    for (let i = 0; i < 3; i++) expect(buffer.push(record(i))).toBe(0);
    expect(buffer.isBatchReady).toBe(true);
    expect(buffer.take().map((r) => r.requestId)).toEqual(['r0', 'r1', 'r2']);
    expect(buffer.size).toBe(0);
    expect(buffer.stats.flushed).toBe(3);
  });

  it('drops the oldest records once the cap is reached, and counts them', () => {
    const buffer = new AuditBuffer(3, 10);
    for (let i = 0; i < 3; i++) buffer.push(record(i));
    expect(buffer.push(record(3))).toBe(1);
    expect(buffer.size).toBe(3);
    expect(buffer.stats.dropped).toBe(1);
    expect(buffer.drain().map((r) => r.requestId)).toEqual(['r1', 'r2', 'r3']);
  });

  it('requeues a failed batch at the front without exceeding the cap', () => {
    const buffer = new AuditBuffer(4, 2);
    for (let i = 0; i < 4; i++) buffer.push(record(i));
    const batch = buffer.take();
    expect(batch.map((r) => r.requestId)).toEqual(['r0', 'r1']);
    buffer.requeue(batch);
    expect(buffer.size).toBe(4);
    expect(buffer.stats.flushed).toBe(0);
    expect(buffer.drain().map((r) => r.requestId)).toEqual([
      'r0',
      'r1',
      'r2',
      'r3',
    ]);
  });

  it('keeps the newest records when a requeue overflows the cap', () => {
    const buffer = new AuditBuffer(3, 2);
    const batch = [record(0), record(1)];
    for (let i = 2; i < 5; i++) buffer.push(record(i));
    buffer.requeue(batch);
    expect(buffer.size).toBe(3);
    expect(buffer.drain().map((r) => r.requestId)).toEqual(['r2', 'r3', 'r4']);
    expect(buffer.stats.dropped).toBe(2);
  });

  it('drains everything regardless of batch size', () => {
    const buffer = new AuditBuffer(100, 500);
    for (let i = 0; i < 7; i++) buffer.push(record(i));
    expect(buffer.drain()).toHaveLength(7);
    expect(buffer.drain()).toEqual([]);
  });
});

describe('normalizeIp', () => {
  it('unwraps IPv4-mapped addresses and keeps plain ones', () => {
    expect(normalizeIp('::ffff:127.0.0.1')).toBe('127.0.0.1');
    expect(normalizeIp('203.0.113.9')).toBe('203.0.113.9');
    expect(normalizeIp('2001:db8::1')).toBe('2001:db8::1');
    expect(normalizeIp('::1')).toBe('::1');
  });

  it('returns null for anything that is not an address, so a batch never fails on INET', () => {
    expect(normalizeIp('unknown')).toBeNull();
    expect(normalizeIp('999.1.1.1')).toBeNull();
    expect(normalizeIp('')).toBeNull();
    expect(normalizeIp(undefined)).toBeNull();
    expect(normalizeIp(null)).toBeNull();
  });
});

describe('truncate', () => {
  it('caps long values and passes short ones through', () => {
    expect(truncate('abc', 10)).toBe('abc');
    expect(truncate('a'.repeat(20), 10)).toHaveLength(10);
    expect(truncate(null, 10)).toBeNull();
    expect(truncate('', 10)).toBeNull();
  });
});

describe('errorSlug', () => {
  it('uses the last segment of the problem type, else the status', () => {
    expect(errorSlug('https://gw/errors/rate-limited', 429)).toBe(
      'rate-limited',
    );
    expect(errorSlug(undefined, 502)).toBe('http-502');
    expect(errorSlug(undefined, 200)).toBeNull();
  });
});

describe('partition helpers', () => {
  it('names partitions by month and parses them back', () => {
    expect(partitionName(new Date(Date.UTC(2026, 8, 1)))).toBe(
      'audit_logs_2026_09',
    );
    expect(partitionName(new Date(Date.UTC(2026, 11, 1)))).toBe(
      'audit_logs_2026_12',
    );
    expect(monthFromPartition('audit_logs_2026_09')).toEqual({
      year: 2026,
      month: 9,
    });
    expect(monthFromPartition('audit_logs')).toBeNull();
    expect(monthFromPartition('something_else')).toBeNull();
  });

  it('parsed month indexes the exclusive end of the partition', () => {
    const parsed = monthFromPartition('audit_logs_2026_09');
    expect(parsed).not.toBeNull();
    const end = new Date(Date.UTC(parsed!.year, parsed!.month, 1));
    expect(end.toISOString().slice(0, 10)).toBe('2026-10-01');
  });
});
