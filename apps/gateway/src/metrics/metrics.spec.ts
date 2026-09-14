import { describe, expect, it } from 'vitest';
import { MetricsService } from './metrics.service.js';

const lines = (text: string): string[] => text.trim().split('\n');
const find = (text: string, prefix: string): string[] =>
  lines(text).filter((l) => l.startsWith(prefix));

describe('MetricsService', () => {
  it('renders a counter with HELP, TYPE and sorted labels', () => {
    const m = new MetricsService();
    m.increment('omnigate_requests_total', { route: 'orders', method: 'GET', status: '2xx' }, 'Requests handled by the gateway.');
    m.increment('omnigate_requests_total', { route: 'orders', method: 'GET', status: '2xx' });
    const out = m.render();

    expect(out).toContain('# HELP omnigate_requests_total Requests handled by the gateway.');
    expect(out).toContain('# TYPE omnigate_requests_total counter');
    expect(out).toContain(
      'omnigate_requests_total{method="GET",route="orders",status="2xx"} 2',
    );
  });

  it('keeps distinct label sets apart', () => {
    const m = new MetricsService();
    m.increment('c', { route: 'a' });
    m.increment('c', { route: 'b' });
    m.increment('c', { route: 'a' });
    expect(find(m.render(), 'c{route="a"}')).toEqual(['c{route="a"} 2']);
    expect(find(m.render(), 'c{route="b"}')).toEqual(['c{route="b"} 1']);
  });

  it('renders a histogram with cumulative buckets, +Inf, sum and count', () => {
    const m = new MetricsService();
    for (const s of [0.002, 0.03, 0.4]) m.observe('d', s, { route: 'orders' });
    const out = m.render();

    expect(out).toContain('# TYPE d histogram');
    // Cumulative: 0.0025 has the 0.002 observation, 0.05 has that plus 0.03.
    expect(out).toContain('d_bucket{le="0.0025",route="orders"} 1');
    expect(out).toContain('d_bucket{le="0.05",route="orders"} 2');
    expect(out).toContain('d_bucket{le="0.5",route="orders"} 3');
    // +Inf must be present and equal the count, or Prometheus rejects the series.
    expect(out).toContain('d_bucket{le="+Inf",route="orders"} 3');
    expect(out).toContain('d_count{route="orders"} 3');
    expect(out).toContain('d_sum{route="orders"} 0.432');
  });

  it('buckets are monotonically non-decreasing', () => {
    const m = new MetricsService();
    for (const s of [0.001, 0.007, 0.007, 2, 30]) m.observe('d', s);
    const counts = find(m.render(), 'd_bucket').map((l) => Number(l.split(' ')[1]));
    for (let i = 1; i < counts.length; i++)
      expect(counts[i]).toBeGreaterThanOrEqual(counts[i - 1]);
  });

  it('escapes quotes and backslashes in label values', () => {
    const m = new MetricsService();
    m.increment('c', { route: 'we"ird\\path' });
    expect(m.render()).toContain('c{route="we\\"ird\\\\path"} 1');
  });

  it('always exposes process gauges', () => {
    const out = new MetricsService().render();
    expect(out).toContain('# TYPE omnigate_process_uptime_seconds gauge');
    expect(out).toContain('omnigate_process_resident_memory_bytes ');
  });

  it('ends with a newline, as the exposition format requires', () => {
    const m = new MetricsService();
    m.increment('c');
    expect(m.render().endsWith('\n')).toBe(true);
  });
});
