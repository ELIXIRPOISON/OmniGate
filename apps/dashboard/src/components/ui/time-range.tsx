import * as React from 'react';
import { cn } from '@/lib/utils';

export interface RangePreset {
  id: string;
  label: string;
  minutes: number;
  /** Bucket width that keeps the series readable without flooding the chart with points. */
  bucket: '1m' | '5m' | '1h';
}

export const RANGE_PRESETS: RangePreset[] = [
  { id: '15m', label: '15m', minutes: 15, bucket: '1m' },
  { id: '1h', label: '1h', minutes: 60, bucket: '1m' },
  { id: '6h', label: '6h', minutes: 360, bucket: '5m' },
  { id: '24h', label: '24h', minutes: 1_440, bucket: '5m' },
  { id: '7d', label: '7d', minutes: 10_080, bucket: '1h' },
];

export interface ResolvedRange {
  preset: RangePreset;
  from: Date;
  to: Date;
  /** The window immediately before this one, for the "vs previous" deltas. */
  previousFrom: Date;
  previousTo: Date;
}

export function resolveRange(preset: RangePreset, now = Date.now()): ResolvedRange {
  const to = new Date(now);
  const from = new Date(now - preset.minutes * 60_000);
  return {
    preset,
    from,
    to,
    previousFrom: new Date(from.getTime() - preset.minutes * 60_000),
    previousTo: from,
  };
}

/**
 * Five presets, so a segmented control beats a dropdown: the current range is always visible and
 * switching costs one click. Sits in a single row above the charts.
 */
export function TimeRangePicker({
  value,
  onChange,
}: {
  value: RangePreset;
  onChange: (preset: RangePreset) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Time range"
      className="flex items-center gap-0.5 rounded-md border border-zinc-950/[0.07] bg-zinc-100/70 p-0.5 dark:border-white/[0.07] dark:bg-white/[0.04]"
    >
      {RANGE_PRESETS.map((preset) => (
        <button
          key={preset.id}
          type="button"
          role="radio"
          aria-checked={preset.id === value.id}
          onClick={() => onChange(preset)}
          className={cn(
            'h-6 rounded px-2 text-[12px] font-medium tabular transition-colors active:scale-[0.98]',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/70',
            preset.id === value.id
              ? 'bg-white text-zinc-900 shadow-sm dark:bg-white/[0.12] dark:text-zinc-50'
              : 'text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-100',
          )}
        >
          {preset.label}
        </button>
      ))}
    </div>
  );
}

/** Live/paused control for the 10 second refresh. Paused is explicit, never a silent stop. */
export function AutoRefreshToggle({
  enabled,
  onChange,
  updatedAt,
}: {
  enabled: boolean;
  onChange: (enabled: boolean) => void;
  updatedAt?: number;
}) {
  // The label ages with the clock, so the clock reading lives in state and ticks on an interval
  // rather than being read during render.
  const [seconds, setSeconds] = React.useState<number | null>(null);
  React.useEffect(() => {
    const tick = () => setSeconds(updatedAt ? Math.round((Date.now() - updatedAt) / 1000) : null);
    tick();
    const id = setInterval(tick, 5_000);
    return () => clearInterval(id);
  }, [updatedAt]);
  return (
    <button
      type="button"
      aria-pressed={enabled}
      onClick={() => onChange(!enabled)}
      title={enabled ? 'Pause auto refresh' : 'Resume auto refresh'}
      className={cn(
        'flex h-7 items-center gap-1.5 rounded-md border px-2 text-[12px] transition-colors active:scale-[0.98]',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/70',
        enabled
          ? 'border-zinc-950/[0.07] bg-zinc-100/70 text-zinc-600 dark:border-white/[0.07] dark:bg-white/[0.04] dark:text-zinc-300'
          : 'border-dashed border-zinc-300 text-zinc-500 dark:border-zinc-700 dark:text-zinc-400',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'h-1.5 w-1.5 rounded-full',
          enabled ? 'animate-pulse bg-ok' : 'bg-zinc-400 dark:bg-zinc-600',
        )}
      />
      {enabled ? (seconds !== null && seconds > 2 ? `${seconds}s ago` : 'Live') : 'Paused'}
    </button>
  );
}
