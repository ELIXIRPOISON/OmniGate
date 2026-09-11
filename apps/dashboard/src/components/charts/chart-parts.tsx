import * as React from 'react';
import { cn } from '@/lib/utils';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';

/** Axis and grid styling shared by every chart, so they read as one system. */
export const axisProps = {
  stroke: 'var(--color-axis)',
  tickLine: false,
  axisLine: false,
  tick: { fontSize: 11, fill: 'var(--color-axis)' },
} as const;

export const gridProps = {
  stroke: 'var(--color-grid)',
  strokeDasharray: '0',
  vertical: false,
} as const;

export interface SeriesKey {
  id: string;
  label: string;
  color: string;
}

/**
 * Frame every chart shares: a title, an always-present legend once there are two or more series,
 * and explicit loading and empty states. An empty range explains itself rather than rendering a
 * blank box.
 */
export function ChartFrame({
  title,
  hint,
  series,
  loading,
  isEmpty,
  emptyHint,
  actions,
  height = 200,
  children,
  className,
}: {
  title: string;
  hint?: string;
  series?: SeriesKey[];
  loading?: boolean;
  isEmpty?: boolean;
  emptyHint?: string;
  actions?: React.ReactNode;
  height?: number;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('surface flex flex-col', className)}>
      <header className="flex items-start justify-between gap-3 px-4 pt-3.5">
        <div className="min-w-0">
          <h2 className="text-chrome font-medium text-zinc-900 dark:text-zinc-100">{title}</h2>
          {hint && <p className="mt-0.5 text-[12px] text-zinc-500 dark:text-zinc-400">{hint}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {series && series.length > 1 && (
            <ul className="flex items-center gap-2.5">
              {series.map((s) => (
                <li key={s.id} className="flex items-center gap-1.5 text-[12px] text-zinc-600 dark:text-zinc-400">
                  <span
                    aria-hidden
                    className="h-2 w-2 rounded-[2px]"
                    style={{ backgroundColor: s.color }}
                  />
                  {s.label}
                </li>
              ))}
            </ul>
          )}
          {actions}
        </div>
      </header>

      <div className="px-1.5 pb-2 pt-3" style={{ minHeight: height }}>
        {loading ? (
          <div className="flex h-full items-end gap-1 px-3 pb-6" style={{ height }}>
            {Array.from({ length: 24 }, (_, i) => (
              <Skeleton key={i} className="flex-1" style={{ height: `${20 + ((i * 37) % 60)}%` }} />
            ))}
          </div>
        ) : isEmpty ? (
          <div style={{ height }} className="flex items-center justify-center">
            <EmptyState
              title="No traffic in this range"
              hint={emptyHint ?? 'Send a request through the gateway, or widen the time range.'}
            />
          </div>
        ) : (
          children
        )}
      </div>
    </section>
  );
}

export interface TooltipRow {
  label: string;
  value: string;
  color?: string;
}

/**
 * Tooltip surface matched to the reference popover: same radius, same hairline border, same shadow.
 * Values wear text tokens; a colour chip beside the label carries series identity.
 */
export function ChartTooltip({ title, rows }: { title: string; rows: TooltipRow[] }) {
  return (
    <div className="pointer-events-none min-w-[9rem] rounded-lg border border-zinc-950/10 bg-white p-2 shadow-lg shadow-zinc-950/10 dark:border-white/10 dark:bg-zinc-900 dark:shadow-black/40">
      <p className="mb-1 text-[11px] font-medium text-zinc-500 dark:text-zinc-400">{title}</p>
      <ul className="flex flex-col gap-0.5">
        {rows.map((row) => (
          <li key={row.label} className="flex items-center gap-2 text-[12px]">
            {row.color && (
              <span
                aria-hidden
                className="h-2 w-2 shrink-0 rounded-[2px]"
                style={{ backgroundColor: row.color }}
              />
            )}
            <span className="text-zinc-600 dark:text-zinc-400">{row.label}</span>
            <span className="ml-auto tabular font-medium text-zinc-900 dark:text-zinc-50">
              {row.value}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Buckets whose value exceeds three times the median of the range. The overview marks these so a
 * spike is visible without reading the axis.
 */
export function findSpikes<T>(points: T[], pick: (point: T) => number): Set<number> {
  const values = points.map(pick).filter((v) => Number.isFinite(v));
  if (values.length < 5) return new Set();
  const sorted = [...values].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  if (median <= 0) return new Set();
  const threshold = median * 3;
  const spikes = new Set<number>();
  points.forEach((point, i) => {
    if (pick(point) > threshold) spikes.add(i);
  });
  return spikes;
}
