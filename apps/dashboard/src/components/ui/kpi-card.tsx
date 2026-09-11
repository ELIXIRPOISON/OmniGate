import { ArrowDown, ArrowUp, Minus } from 'lucide-react';
import * as React from 'react';
import { cn } from '@/lib/utils';
import { Skeleton } from './skeleton';
import { Sparkline } from './sparkline';

export type DeltaDirection = 'up' | 'down' | 'flat';

/** Whether a rise is good news depends on the metric: more requests is fine, more errors is not. */
export type DeltaPolarity = 'more-is-good' | 'less-is-good' | 'neutral';

function deltaTone(direction: DeltaDirection, polarity: DeltaPolarity): string {
  if (direction === 'flat' || polarity === 'neutral') return 'text-zinc-500 dark:text-zinc-400';
  const good = polarity === 'more-is-good' ? direction === 'up' : direction === 'down';
  return good ? 'text-ok' : 'text-critical';
}

export interface KpiCardProps {
  label: string;
  value: React.ReactNode;
  /** Secondary line under the value, e.g. the absolute count behind a percentage. */
  detail?: React.ReactNode;
  previous?: number | null;
  current?: number | null;
  polarity?: DeltaPolarity;
  spark?: number[];
  sparkColor?: string;
  /** False when the previous window holds no traffic, so a delta would be meaningless. */
  comparable?: boolean;
  loading?: boolean;
  className?: string;
}

export function KpiCard({
  label,
  value,
  detail,
  previous,
  current,
  polarity = 'neutral',
  spark,
  sparkColor,
  comparable = true,
  loading,
  className,
}: KpiCardProps) {
  // A delta against an empty window is not a comparison, it is noise. Callers pass
  // `comparable={false}` when the previous window had no traffic at all.
  const delta = comparable ? computeDelta(current, previous) : null;

  return (
    <div className={cn('surface flex flex-col overflow-hidden', className)}>
      <div className="flex flex-col gap-1.5 p-3.5 pb-2.5">
        <p className="truncate text-[12px] font-medium text-zinc-500 dark:text-zinc-400">{label}</p>

        {loading ? (
          <Skeleton className="h-7 w-24" />
        ) : (
          <p className="text-[26px] font-semibold leading-none tracking-[-0.02em] text-zinc-900 dark:text-zinc-50">
            {value}
          </p>
        )}

        {loading ? (
          <Skeleton className="h-3 w-20" />
        ) : delta ? (
          <p
            className={cn(
              'flex items-center gap-1 truncate whitespace-nowrap text-[12px]',
              deltaTone(delta.direction, polarity),
            )}
          >
            {delta.direction === 'up' ? (
              <ArrowUp className="h-3 w-3 shrink-0" aria-hidden />
            ) : delta.direction === 'down' ? (
              <ArrowDown className="h-3 w-3 shrink-0" aria-hidden />
            ) : (
              <Minus className="h-3 w-3 shrink-0" aria-hidden />
            )}
            <span className="tabular">{delta.label}</span>
            <span className="truncate text-zinc-400 dark:text-zinc-500">vs previous</span>
          </p>
        ) : (
          <p className="truncate whitespace-nowrap text-[12px] text-zinc-500 dark:text-zinc-400">
            {detail}
          </p>
        )}
      </div>

      {/* The sparkline sits full width along the bottom edge, so it never competes for the
          horizontal space the label and delta need. */}
      {spark && spark.length > 1 && !loading && (
        <Sparkline values={spark} className="w-full" stroke={sparkColor} height={26} />
      )}
    </div>
  );
}

function computeDelta(
  current: number | null | undefined,
  previous: number | null | undefined,
): { direction: DeltaDirection; label: string } | null {
  if (current === null || current === undefined || previous === null || previous === undefined) {
    return null;
  }
  if (previous === 0) {
    if (current === 0) return { direction: 'flat', label: 'no change' };
    return { direction: 'up', label: 'new' };
  }
  const change = (current - previous) / previous;
  if (Math.abs(change) < 0.005) return { direction: 'flat', label: 'no change' };
  return {
    direction: change > 0 ? 'up' : 'down',
    label: `${change > 0 ? '+' : ''}${(change * 100).toFixed(change > -0.1 && change < 0.1 ? 1 : 0)}%`,
  };
}
