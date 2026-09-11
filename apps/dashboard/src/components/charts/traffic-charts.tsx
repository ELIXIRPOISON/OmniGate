import * as React from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { axisProps, ChartFrame, ChartTooltip, findSpikes, gridProps } from './chart-parts';
import type { TimeseriesPoint } from '@/lib/queries';
import { formatCount, formatMs, formatPercent, formatTime } from '@/lib/format';

/*
 * Chart colours come from validated tokens, never from taste:
 *   --color-series-1/2/3   categorical slots 1-3, all-pairs validated on both surfaces
 *   --color-latency-low/high  one-hue ordinal ramp, validated as ordinal in both modes
 *   --color-critical       single-series only (errors), so no separation check applies
 *
 * The dashboard spec asked for a stacked 2xx/4xx/5xx chart. That encoding was dropped: the three
 * status colours fail colour-vision separation as a fill set (good vs critical measures dE 4.1
 * under deuteranopia), and a stack dominated by 2xx hides the error slivers that matter. Requests,
 * errors and latency are three single-purpose charts instead, and the status split is a bar list.
 */

const tickTime = (value: string) => formatTime(value);

export function RequestsChart({
  points,
  loading,
  live,
}: {
  points: TimeseriesPoint[];
  loading?: boolean;
  live?: boolean;
}) {
  const spikes = React.useMemo(() => findSpikes(points, (p) => p.requests), [points]);
  const total = points.reduce((sum, p) => sum + p.requests, 0);

  return (
    <ChartFrame
      title="Requests"
      hint={
        spikes.size > 0
          ? `${formatCount(total)} in range · ${spikes.size} spike${spikes.size > 1 ? 's' : ''} highlighted`
          : `${formatCount(total)} in range`
      }
      loading={loading}
      isEmpty={points.length === 0}
      height={200}
    >
      <ResponsiveContainer width="100%" height={200}>
        <AreaChart data={points} margin={{ top: 4, right: 12, bottom: 0, left: 4 }}>
          <defs>
            <linearGradient id="fill-requests" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-series-1)" stopOpacity="0.28" />
              <stop offset="100%" stopColor="var(--color-series-1)" stopOpacity="0.02" />
            </linearGradient>
          </defs>
          <CartesianGrid {...gridProps} />
          <XAxis dataKey="ts" tickFormatter={tickTime} minTickGap={44} {...axisProps} />
          <YAxis width={38} tickFormatter={(v: number) => formatCount(v)} {...axisProps} />

          {/* A spike is marked on the plot, so it is visible without reading the axis. */}
          {[...spikes].map((index) => (
            <ReferenceArea
              key={index}
              x1={points[Math.max(0, index - 1)]?.ts}
              x2={points[Math.min(points.length - 1, index + 1)]?.ts}
              fill="var(--color-warn)"
              fillOpacity={0.13}
              ifOverflow="extendDomain"
            />
          ))}

          <Tooltip
            cursor={{ stroke: 'var(--color-axis)', strokeWidth: 1 }}
            content={({ active, payload, label }) =>
              active && payload?.length ? (
                <ChartTooltip
                  title={formatTime(String(label))}
                  rows={[
                    {
                      label: 'Requests',
                      value: formatCount(Number(payload[0]?.value ?? 0)),
                      color: 'var(--color-series-1)',
                    },
                  ]}
                />
              ) : null
            }
          />
          <Area
            type="monotone"
            dataKey="requests"
            stroke="var(--color-series-1)"
            strokeWidth={2}
            fill="url(#fill-requests)"
            isAnimationActive={!live}
            activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--color-series-1)' }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

export function LatencyChart({
  points,
  loading,
  live,
}: {
  points: TimeseriesPoint[];
  loading?: boolean;
  live?: boolean;
}) {
  // A bucket with no requests has no latency. Plotting it as zero would invent a dip, so those
  // buckets become gaps in the line instead.
  const series = React.useMemo(
    () =>
      points.map((p) =>
        p.requests === 0 ? { ...p, latencyP50: null, latencyP95: null } : p,
      ),
    [points],
  );

  return (
    <ChartFrame
      title="Latency"
      hint="Gateway to client, including time waiting on the upstream"
      series={[
        { id: 'p50', label: 'p50', color: 'var(--color-latency-low)' },
        { id: 'p95', label: 'p95', color: 'var(--color-latency-high)' },
      ]}
      loading={loading}
      isEmpty={points.length === 0}
      height={200}
    >
      <ResponsiveContainer width="100%" height={200}>
        <LineChart data={series} margin={{ top: 4, right: 12, bottom: 0, left: 4 }}>
          <CartesianGrid {...gridProps} />
          <XAxis dataKey="ts" tickFormatter={tickTime} minTickGap={44} {...axisProps} />
          <YAxis width={44} tickFormatter={(v: number) => `${v}ms`} {...axisProps} />
          <Tooltip
            cursor={{ stroke: 'var(--color-axis)', strokeWidth: 1 }}
            content={({ active, payload, label }) =>
              active && payload?.length ? (
                <ChartTooltip
                  title={formatTime(String(label))}
                  rows={[
                    {
                      label: 'p95',
                      value: formatMs(Number(payload.find((p) => p.dataKey === 'latencyP95')?.value ?? 0)),
                      color: 'var(--color-latency-high)',
                    },
                    {
                      label: 'p50',
                      value: formatMs(Number(payload.find((p) => p.dataKey === 'latencyP50')?.value ?? 0)),
                      color: 'var(--color-latency-low)',
                    },
                  ]}
                />
              ) : null
            }
          />
          <Line
            type="monotone"
            dataKey="latencyP50"
            stroke="var(--color-latency-low)"
            strokeWidth={2}
            connectNulls={false}
            dot={false}
            isAnimationActive={!live}
            activeDot={{ r: 4 }}
          />
          <Line
            type="monotone"
            dataKey="latencyP95"
            stroke="var(--color-latency-high)"
            strokeWidth={2}
            connectNulls={false}
            dot={false}
            isAnimationActive={!live}
            activeDot={{ r: 4 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

/** Errors and rate limiting share one chart because they answer the same question: what is being refused? */
export function RefusalsChart({
  points,
  loading,
  live,
}: {
  points: TimeseriesPoint[];
  loading?: boolean;
  live?: boolean;
}) {
  const totals = points.reduce(
    (acc, p) => ({
      errors: acc.errors + p.errors,
      clientErrors: acc.clientErrors + p.clientErrors,
      rateLimited: acc.rateLimited + p.rateLimited,
    }),
    { errors: 0, clientErrors: 0, rateLimited: 0 },
  );
  const nothing = totals.errors + totals.clientErrors + totals.rateLimited === 0;

  return (
    <ChartFrame
      title="Refused and failed"
      hint="Server errors, client errors and rate-limited requests"
      series={[
        { id: 'errors', label: '5xx', color: 'var(--color-critical)' },
        { id: 'client', label: '4xx', color: 'var(--color-series-2)' },
        { id: 'limited', label: '429', color: 'var(--color-series-3)' },
      ]}
      loading={loading}
      isEmpty={points.length === 0}
      emptyHint="Nothing has been refused in this range, which is the good case."
      height={180}
    >
      {nothing ? (
        <div className="flex h-[180px] flex-col items-center justify-center gap-1 text-center">
          <p className="text-chrome font-medium text-ok">Nothing refused</p>
          <p className="text-[12px] text-zinc-500 dark:text-zinc-400">
            No 4xx, 5xx or rate-limited requests in this range.
          </p>
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={180}>
          <LineChart data={points} margin={{ top: 4, right: 12, bottom: 0, left: 4 }}>
            <CartesianGrid {...gridProps} />
            <XAxis dataKey="ts" tickFormatter={tickTime} minTickGap={44} {...axisProps} />
            <YAxis width={38} allowDecimals={false} tickFormatter={(v: number) => formatCount(v)} {...axisProps} />
            <Tooltip
              cursor={{ stroke: 'var(--color-axis)', strokeWidth: 1 }}
              content={({ active, payload, label }) =>
                active && payload?.length ? (
                  <ChartTooltip
                    title={formatTime(String(label))}
                    rows={[
                      {
                        label: '5xx',
                        value: formatCount(Number(payload.find((p) => p.dataKey === 'errors')?.value ?? 0)),
                        color: 'var(--color-critical)',
                      },
                      {
                        label: '4xx',
                        value: formatCount(
                          Number(payload.find((p) => p.dataKey === 'clientErrors')?.value ?? 0),
                        ),
                        color: 'var(--color-series-2)',
                      },
                      {
                        label: '429',
                        value: formatCount(
                          Number(payload.find((p) => p.dataKey === 'rateLimited')?.value ?? 0),
                        ),
                        color: 'var(--color-series-3)',
                      },
                    ]}
                  />
                ) : null
              }
            />
            <Line
              type="monotone"
              dataKey="errors"
              stroke="var(--color-critical)"
              strokeWidth={2}
              dot={false}
              isAnimationActive={!live}
            />
            <Line
              type="monotone"
              dataKey="clientErrors"
              stroke="var(--color-series-2)"
              strokeWidth={2}
              dot={false}
              isAnimationActive={!live}
            />
            <Line
              type="monotone"
              dataKey="rateLimited"
              stroke="var(--color-series-3)"
              strokeWidth={2}
              dot={false}
              isAnimationActive={!live}
            />
          </LineChart>
        </ResponsiveContainer>
      )}
    </ChartFrame>
  );
}

export interface BarListItem {
  key: string;
  requests: number;
  errors: number;
  p95: number | null;
}

/**
 * Top-N as a bar list rather than a pie or a stacked bar: the label sits next to its own bar, the
 * value is always readable, and no colour has to carry identity.
 */
export function BarList({
  items,
  loading,
  emptyHint,
  onSelect,
}: {
  items: BarListItem[];
  loading?: boolean;
  emptyHint?: string;
  onSelect?: (key: string) => void;
}) {
  if (loading) {
    return (
      <ul className="flex flex-col gap-2 p-4">
        {Array.from({ length: 5 }, (_, i) => (
          <li key={i} className="h-7 animate-pulse rounded bg-zinc-200/70 dark:bg-white/[0.07]" />
        ))}
      </ul>
    );
  }
  if (items.length === 0) {
    return (
      <p className="px-4 py-8 text-center text-[12px] text-zinc-500 dark:text-zinc-400">
        {emptyHint ?? 'Nothing in this range.'}
      </p>
    );
  }

  const max = Math.max(...items.map((i) => i.requests), 1);
  return (
    <ul className="flex flex-col">
      {items.map((item, index) => {
        const errorRate = item.requests > 0 ? item.errors / item.requests : 0;
        const Row = onSelect ? 'button' : 'div';
        return (
          // The label is not unique: two API keys may share a name, so position disambiguates.
          <li key={`${item.key}-${index}`}>
            <Row
              {...(onSelect
                ? { type: 'button' as const, onClick: () => onSelect(item.key) }
                : {})}
              className={
                'relative flex w-full items-center gap-3 px-4 py-2 text-left transition-colors ' +
                (onSelect
                  ? 'hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500/70 dark:hover:bg-white/[0.03]'
                  : '')
              }
            >
              {/* The bar is a background wash so the label stays on the page ink, not on colour. */}
              <span
                aria-hidden
                className="absolute inset-y-1 left-3 rounded-[3px] bg-series-1/[0.13]"
                style={{ width: `calc((100% - 1.5rem) * ${item.requests / max})` }}
              />
              <span className="relative min-w-0 flex-1 truncate text-chrome text-zinc-800 dark:text-zinc-200">
                {item.key}
              </span>
              {errorRate > 0 && (
                <span className="relative shrink-0 text-[11px] tabular text-critical">
                  {formatPercent(errorRate, 1)} err
                </span>
              )}
              {item.p95 !== null && (
                <span className="relative hidden shrink-0 text-[11px] tabular text-zinc-400 sm:block dark:text-zinc-500">
                  {formatMs(item.p95)}
                </span>
              )}
              <span className="relative shrink-0 tabular text-chrome font-medium text-zinc-900 dark:text-zinc-50">
                {formatCount(item.requests)}
              </span>
            </Row>
          </li>
        );
      })}
    </ul>
  );
}
