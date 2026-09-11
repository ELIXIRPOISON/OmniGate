import { ScrollText } from 'lucide-react';
import * as React from 'react';
import { useSearchParams } from 'react-router-dom';
import { MobilePageTitle, PageHeader } from '@/components/shell/app-shell';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { DataTable, type Column } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import {
  FilterBar,
  type Filter,
  type FilterFieldDef,
} from '@/components/ui/filter-token-bar';
import { ProblemAlert } from '@/components/ui/problem-alert';
import { AutoRefreshToggle, TimeRangePicker } from '@/components/ui/time-range';
import { useRangeState } from '@/hooks/use-range-state';
import { formatBytes, formatMs, formatTimestamp } from '@/lib/format';
import { type LogRow, useLogs, useRoutes } from '@/lib/queries';
import { cn } from '@/lib/utils';

/** Glyphs so a filter token reads without depending on its label alone. */
const Dot = ({ className }: { className?: string }) => (
  <span aria-hidden className={cn('block h-2 w-2 rounded-full', className)} />
);

export function LogsPage() {
  const { range, preset, setPreset, live, setLive } = useRangeState();
  const [params, setParams] = useSearchParams();
  const routes = useRoutes();
  const [selected, setSelected] = React.useState<LogRow | null>(null);

  // A route arriving from the overview's top-routes list becomes a real filter token.
  const [filters, setFilters] = React.useState<Filter[]>(() => {
    const route = params.get('route');
    return route ? [{ id: 'from-link', field: 'route', operator: 'is', values: [route] }] : [];
  });

  React.useEffect(() => {
    if (params.get('route')) setParams({}, { replace: true });
  }, [params, setParams]);

  const fields: FilterFieldDef[] = React.useMemo(
    () => [
      {
        id: 'statusClass',
        label: 'Status',
        icon: <Dot className="bg-zinc-400" />,
        operators: [{ value: 'is', label: 'is' }],
        options: [
          { value: '2xx', label: '2xx success', glyph: <Dot className="bg-ok" /> },
          { value: '3xx', label: '3xx redirect', glyph: <Dot className="bg-zinc-400" /> },
          { value: '4xx', label: '4xx client error', glyph: <Dot className="bg-warn" /> },
          { value: '5xx', label: '5xx server error', glyph: <Dot className="bg-critical" /> },
        ],
      },
      {
        id: 'route',
        label: 'Route',
        operators: [{ value: 'is', label: 'is' }],
        options: (routes.data?.items ?? []).map((r) => ({ value: r.service, label: r.service })),
      },
      {
        id: 'cacheStatus',
        label: 'Cache',
        operators: [{ value: 'is', label: 'is' }],
        options: [
          { value: 'HIT', label: 'HIT', glyph: <Dot className="bg-series-3" /> },
          { value: 'MISS', label: 'MISS', glyph: <Dot className="bg-series-2" /> },
          { value: 'BYPASS', label: 'BYPASS', glyph: <Dot className="bg-zinc-400" /> },
        ],
      },
      {
        id: 'rateLimited',
        label: 'Rate limited',
        operators: [{ value: 'is', label: 'is' }],
        options: [
          { value: 'true', label: 'Yes' },
          { value: 'false', label: 'No' },
        ],
      },
      {
        id: 'minLatencyMs',
        label: 'Slower than',
        operators: [{ value: 'is', label: 'is' }],
        options: [
          { value: '50', label: '50 ms' },
          { value: '100', label: '100 ms' },
          { value: '250', label: '250 ms' },
          { value: '1000', label: '1 s' },
        ],
      },
    ],
    [routes.data],
  );

  const query = React.useMemo(() => {
    const out: Record<string, string | number | boolean | undefined> = {
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      limit: 200,
    };
    for (const filter of filters) {
      const value = filter.values[0];
      if (!value) continue;
      if (filter.field === 'route') {
        const match = routes.data?.items.find((r) => r.service === value);
        if (match) out.routeId = match.id;
      } else if (filter.field === 'rateLimited') {
        out.rateLimited = value;
      } else if (filter.field === 'minLatencyMs') {
        out.minLatencyMs = Number(value);
      } else {
        out[filter.field] = value;
      }
    }
    return out;
  }, [filters, range, routes.data]);

  const logs = useLogs(query, live);

  const columns: Column<LogRow>[] = [
    {
      id: 'ts',
      header: 'Time',
      width: '7rem',
      cell: (row) => <span className="tabular text-zinc-500 dark:text-zinc-400">{formatTimestamp(row.ts)}</span>,
    },
    { id: 'status', header: 'Status', width: '5rem', cell: (row) => <StatusBadge status={row.status} /> },
    {
      id: 'request',
      header: 'Request',
      cell: (row) => (
        <span className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 font-mono text-[11px] text-zinc-400 dark:text-zinc-500">{row.method}</span>
          <span className="truncate font-mono text-[12px]">{row.path}</span>
        </span>
      ),
    },
    {
      id: 'route',
      header: 'Route',
      secondary: true,
      width: '8rem',
      cell: (row) => row.route ?? <span className="text-zinc-400 dark:text-zinc-600">unrouted</span>,
    },
    {
      id: 'cache',
      header: 'Cache',
      secondary: true,
      width: '6rem',
      cell: (row) =>
        row.cacheStatus ? (
          <Badge tone={row.cacheStatus === 'HIT' ? 'ok' : 'neutral'}>{row.cacheStatus}</Badge>
        ) : (
          <span className="text-zinc-300 dark:text-zinc-700">—</span>
        ),
    },
    { id: 'latency', header: 'Latency', align: 'right', width: '5.5rem', cell: (row) => formatMs(row.latencyMs) },
  ];

  const controls = (
    <>
      <TimeRangePicker value={preset} onChange={setPreset} />
      <AutoRefreshToggle enabled={live} onChange={setLive} updatedAt={logs.dataUpdatedAt} />
    </>
  );

  return (
    <>
      <PageHeader title="Logs" description="Every request the gateway handled" actions={controls} />
      <MobilePageTitle title="Logs" actions={controls} />

      <div className="flex flex-col gap-4 p-4 lg:p-6">
        {/* Filters live in one row above the data, per the interaction spec. */}
        <FilterBar
          fields={fields}
          value={filters}
          onChange={setFilters}
          aria-label="Log filters"
          emptyLabel="Add filter"
        />

        {logs.isError && <ProblemAlert error={logs.error} onRetry={() => void logs.refetch()} />}

        <Card>
          <DataTable
            columns={columns}
            rows={logs.data?.items ?? []}
            rowKey={(row) => row.requestId + row.ts}
            loading={logs.isLoading}
            onRowClick={setSelected}
            caption="Requests handled by the gateway in the selected range"
            empty={
              <EmptyState
                icon={<ScrollText className="h-6 w-6" />}
                title="No requests match"
                hint="Widen the time range or remove a filter."
              />
            }
          />
          {logs.data && logs.data.items.length >= 200 && (
            <p className="border-t border-zinc-950/[0.07] px-4 py-2 text-[12px] text-zinc-500 dark:border-white/[0.07] dark:text-zinc-400">
              Showing the 200 most recent. Narrow the range or add a filter to see further back.
            </p>
          )}
        </Card>
      </div>

      {selected && <LogDetail row={selected} onClose={() => setSelected(null)} />}
    </>
  );
}

/** Row detail as a side sheet: the list keeps its place, and Escape closes it. */
function LogDetail({ row, onClose }: { row: LogRow; onClose: () => void }) {
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const rows: [string, React.ReactNode][] = [
    ['Request id', <span key="rid" className="font-mono text-[12px]">{row.requestId}</span>],
    ['Time', formatTimestamp(row.ts)],
    ['Method', row.method],
    ['Path', <span key="path" className="break-all font-mono text-[12px]">{row.path}</span>],
    ['Status', <StatusBadge key="status" status={row.status} />],
    ['Latency', formatMs(row.latencyMs)],
    ['Upstream', row.upstreamMs === null ? '—' : formatMs(row.upstreamMs)],
    ['Route', row.route ?? 'unrouted'],
    ['Principal', <span key="principal" className="font-mono text-[12px]">{row.principal ?? '—'}</span>],
    ['API key', row.apiKeyName ?? '—'],
    ['Client IP', <span key="ip" className="font-mono text-[12px]">{row.clientIp ?? '—'}</span>],
    ['Cache', row.cacheStatus ?? '—'],
    ['Rate limited', row.rateLimited ? 'yes' : 'no'],
    ['Anomaly score', row.anomalyScore === null ? '—' : row.anomalyScore.toFixed(3)],
    ['Error type', row.errorType ?? '—'],
    ['Request size', formatBytes(row.reqBytes)],
    ['Response size', formatBytes(row.resBytes)],
    ['User agent', <span key="ua" className="break-all text-[12px]">{row.userAgent ?? '—'}</span>],
  ];

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <button type="button" aria-label="Close details" onClick={onClose} className="flex-1 bg-zinc-950/20 dark:bg-black/50" />
      <aside
        role="dialog"
        aria-label="Request detail"
        className="scrollbar-thin w-full max-w-md overflow-y-auto border-l border-zinc-950/[0.07] bg-white p-4 dark:border-white/[0.07] dark:bg-zinc-900"
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-chrome font-medium text-zinc-900 dark:text-zinc-100">Request detail</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-1.5 py-0.5 text-[12px] text-zinc-500 hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/70 dark:text-zinc-400 dark:hover:bg-white/[0.06]"
          >
            Close
          </button>
        </div>
        <dl className="flex flex-col">
          {rows.map(([label, value]) => (
            <div
              key={label}
              className="flex gap-3 border-b border-zinc-950/[0.05] py-1.5 last:border-0 dark:border-white/[0.05]"
            >
              <dt className="w-32 shrink-0 text-[12px] text-zinc-500 dark:text-zinc-400">{label}</dt>
              <dd className="min-w-0 flex-1 text-chrome text-zinc-800 dark:text-zinc-200">{value}</dd>
            </div>
          ))}
        </dl>
      </aside>
    </div>
  );
}
