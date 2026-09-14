import { Injectable } from '@nestjs/common';

/**
 * A small Prometheus registry.
 *
 * Written rather than pulled in: the exposition format is a dozen lines of rules, the gateway needs
 * four counters and two histograms, and a dependency here lands in the runtime image, which Sprint 9
 * spent real effort shrinking. The format is the contract, so `metrics.spec.ts` asserts it.
 *
 * Everything is in-process and per-replica, which is what Prometheus expects: it scrapes each
 * instance and aggregates. Nothing here is a source of truth - the audit log is - so a restart
 * losing counters is correct rather than a gap.
 */

/** Seconds. The default set, with the low end kept dense because the gateway's own overhead is sub-millisecond. */
const DURATION_BUCKETS = [
  0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

type Labels = Record<string, string>;

/** Label values go inside quotes, so backslash, quote and newline have to be escaped. */
const escapeLabel = (value: string): string =>
  value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

const labelKey = (labels: Labels): string =>
  Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k]}`)
    .join(',');

const renderLabels = (labels: Labels, extra?: Labels): string => {
  const all = { ...labels, ...extra };
  const keys = Object.keys(all).sort();
  if (keys.length === 0) return '';
  return `{${keys.map((k) => `${k}="${escapeLabel(all[k])}"`).join(',')}}`;
};

interface Series<T> {
  labels: Labels;
  value: T;
}

interface HistogramValue {
  counts: number[];
  sum: number;
  count: number;
}

@Injectable()
export class MetricsService {
  private readonly counters = new Map<string, Map<string, Series<number>>>();
  private readonly histograms = new Map<
    string,
    Map<string, Series<HistogramValue>>
  >();
  private readonly help = new Map<string, string>();
  private readonly startedAt = Date.now();

  /**
   * Cardinality is the way a metrics endpoint kills a process. Labels here are always bounded
   * values: route names, methods, status classes. A raw path or principal would not be.
   */
  increment(name: string, labels: Labels = {}, help?: string, by = 1): void {
    if (help) this.help.set(name, help);
    let series = this.counters.get(name);
    if (!series) {
      series = new Map();
      this.counters.set(name, series);
    }
    const key = labelKey(labels);
    const existing = series.get(key);
    if (existing) existing.value += by;
    else series.set(key, { labels, value: by });
  }

  observe(name: string, seconds: number, labels: Labels = {}, help?: string): void {
    if (help) this.help.set(name, help);
    let series = this.histograms.get(name);
    if (!series) {
      series = new Map();
      this.histograms.set(name, series);
    }
    const key = labelKey(labels);
    let entry = series.get(key);
    if (!entry) {
      entry = {
        labels,
        value: { counts: new Array(DURATION_BUCKETS.length).fill(0), sum: 0, count: 0 },
      };
      series.set(key, entry);
    }
    entry.value.sum += seconds;
    entry.value.count += 1;
    for (let i = 0; i < DURATION_BUCKETS.length; i++) {
      if (seconds <= DURATION_BUCKETS[i]) entry.value.counts[i] += 1;
    }
  }

  /** Prometheus text exposition, version 0.0.4. */
  render(): string {
    const lines: string[] = [];

    for (const [name, series] of this.counters) {
      const help = this.help.get(name);
      if (help) lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} counter`);
      for (const { labels, value } of series.values())
        lines.push(`${name}${renderLabels(labels)} ${value}`);
    }

    for (const [name, series] of this.histograms) {
      const help = this.help.get(name);
      if (help) lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} histogram`);
      for (const { labels, value } of series.values()) {
        // Buckets are cumulative, and +Inf must always be present and equal to _count.
        let cumulative = 0;
        for (let i = 0; i < DURATION_BUCKETS.length; i++) {
          cumulative = value.counts[i];
          lines.push(
            `${name}_bucket${renderLabels(labels, { le: String(DURATION_BUCKETS[i]) })} ${cumulative}`,
          );
        }
        lines.push(
          `${name}_bucket${renderLabels(labels, { le: '+Inf' })} ${value.count}`,
        );
        lines.push(`${name}_sum${renderLabels(labels)} ${value.sum}`);
        lines.push(`${name}_count${renderLabels(labels)} ${value.count}`);
      }
    }

    const mem = process.memoryUsage();
    lines.push('# HELP omnigate_process_uptime_seconds Time since this replica started.');
    lines.push('# TYPE omnigate_process_uptime_seconds gauge');
    lines.push(
      `omnigate_process_uptime_seconds ${((Date.now() - this.startedAt) / 1000).toFixed(3)}`,
    );
    lines.push('# HELP omnigate_process_resident_memory_bytes Resident set size.');
    lines.push('# TYPE omnigate_process_resident_memory_bytes gauge');
    lines.push(`omnigate_process_resident_memory_bytes ${mem.rss}`);

    return `${lines.join('\n')}\n`;
  }
}
