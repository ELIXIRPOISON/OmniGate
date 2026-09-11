import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ShieldAlert, ShieldCheck } from 'lucide-react';
import * as React from 'react';
import { useSearchParams } from 'react-router-dom';
import { MobilePageTitle, PageHeader } from '@/components/shell/app-shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { DataTable, type Column } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { FilterBar, type Filter, type FilterFieldDef } from '@/components/ui/filter-token-bar';
import { ProblemAlert } from '@/components/ui/problem-alert';
import { api } from '@/lib/api';
import { formatRelative, formatTimestamp } from '@/lib/format';
import { type AnomalyRow, useAnomalies } from '@/lib/queries';
import { cn } from '@/lib/utils';

const Dot = ({ className }: { className?: string }) => (
  <span aria-hidden className={cn('block h-2 w-2 rounded-full', className)} />
);

function scoreTone(score: number) {
  return score >= 0.9 ? 'critical' : score >= 0.7 ? 'serious' : score >= 0.3 ? 'warn' : 'neutral';
}

export function AnomaliesPage() {
  const [params, setParams] = useSearchParams();
  const [filters, setFilters] = React.useState<Filter[]>([]);
  const [selectedId, setSelectedId] = React.useState<string | null>(params.get('id'));

  React.useEffect(() => {
    if (params.get('id')) setParams({}, { replace: true });
  }, [params, setParams]);

  const fields: FilterFieldDef[] = [
    {
      id: 'verdict',
      label: 'Verdict',
      icon: <Dot className="bg-zinc-400" />,
      operators: [{ value: 'is', label: 'is' }],
      options: [
        { value: 'malicious', label: 'Malicious', glyph: <Dot className="bg-critical" /> },
        { value: 'suspicious', label: 'Suspicious', glyph: <Dot className="bg-serious" /> },
        { value: 'benign', label: 'Benign', glyph: <Dot className="bg-ok" /> },
      ],
    },
    {
      id: 'minScore',
      label: 'Score',
      operators: [{ value: 'gte', label: 'at least' }],
      options: [
        { value: '0.3', label: '0.30' },
        { value: '0.5', label: '0.50' },
        { value: '0.7', label: '0.70' },
        { value: '0.9', label: '0.90' },
      ],
    },
    {
      id: 'blocked',
      label: 'Blocked',
      operators: [{ value: 'is', label: 'is' }],
      options: [
        { value: 'true', label: 'Yes' },
        { value: 'false', label: 'No' },
      ],
    },
    {
      id: 'reviewed',
      label: 'Reviewed',
      operators: [{ value: 'is', label: 'is' }],
      options: [
        { value: 'false', label: 'Not yet' },
        { value: 'true', label: 'Reviewed' },
      ],
    },
  ];

  const query = React.useMemo(() => {
    const out: Record<string, string | number | undefined> = { pageSize: 100 };
    for (const filter of filters) {
      const value = filter.values[0];
      if (value) out[filter.field] = value;
    }
    return out;
  }, [filters]);

  const anomalies = useAnomalies(query);
  const selected = anomalies.data?.items.find((a) => a.id === selectedId) ?? null;

  const columns: Column<AnomalyRow>[] = [
    {
      id: 'time',
      header: 'Time',
      width: '7rem',
      cell: (row) => <span className="tabular text-zinc-500 dark:text-zinc-400">{formatTimestamp(row.createdAt)}</span>,
    },
    {
      id: 'score',
      header: 'Score',
      width: '5rem',
      cell: (row) => {
        const score = row.llmScore ?? row.heuristicScore;
        return <Badge tone={scoreTone(score)}>{score.toFixed(2)}</Badge>;
      },
    },
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
      id: 'categories',
      header: 'Categories',
      secondary: true,
      cell: (row) =>
        row.categories.length === 0 ? (
          <span className="text-zinc-400 dark:text-zinc-600">—</span>
        ) : (
          <span className="flex flex-wrap gap-1">
            {row.categories.slice(0, 3).map((c) => (
              <Badge key={c}>{c}</Badge>
            ))}
          </span>
        ),
    },
    {
      id: 'state',
      header: 'State',
      width: '8rem',
      cell: (row) => (
        <span className="flex gap-1">
          {row.blocked && <Badge tone="critical">blocked</Badge>}
          {row.reviewed && (
            <Badge tone={row.reviewLabel === 'false_positive' ? 'neutral' : 'ok'}>
              {row.reviewLabel === 'false_positive' ? 'false pos' : 'confirmed'}
            </Badge>
          )}
        </span>
      ),
    },
  ];

  return (
    <>
      <PageHeader title="Anomalies" description="Requests the detector flagged, and what happened to them" />
      <MobilePageTitle title="Anomalies" />

      <div className="flex flex-col gap-4 p-4 lg:p-6">
        <FilterBar fields={fields} value={filters} onChange={setFilters} aria-label="Anomaly filters" />

        {anomalies.isError && <ProblemAlert error={anomalies.error} onRetry={() => void anomalies.refetch()} />}

        <Card>
          <DataTable
            columns={columns}
            rows={anomalies.data?.items ?? []}
            rowKey={(row) => row.id}
            loading={anomalies.isLoading}
            onRowClick={(row) => setSelectedId(row.id)}
            caption="Flagged requests"
            empty={
              <EmptyState
                icon={<ShieldCheck className="h-6 w-6" />}
                title="Nothing flagged"
                hint="No request has been scored above the gate threshold with these filters."
              />
            }
          />
        </Card>
      </div>

      {selected && <AnomalyDrawer row={selected} onClose={() => setSelectedId(null)} />}
    </>
  );
}

/** Review drawer: the evidence, then the two decisions an operator can make about it. */
function AnomalyDrawer({ row, onClose }: { row: AnomalyRow; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [error, setError] = React.useState<unknown>(null);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const review = useMutation({
    mutationFn: (label: 'true_positive' | 'false_positive') =>
      api(`/admin/v1/anomalies/${row.id}/review`, { method: 'PATCH', body: { reviewed: true, label } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['anomalies'] });
      onClose();
    },
    onError: setError,
  });

  const throttle = useMutation({
    mutationFn: () => api(`/admin/v1/anomalies/${row.id}/throttle-key`, { method: 'POST', body: { seconds: 600 } }),
    onError: setError,
  });

  const score = row.llmScore ?? row.heuristicScore;

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <button type="button" aria-label="Close" onClick={onClose} className="flex-1 bg-zinc-950/20 dark:bg-black/50" />
      <aside
        role="dialog"
        aria-label="Anomaly detail"
        className="scrollbar-thin flex w-full max-w-md flex-col overflow-y-auto border-l border-zinc-950/[0.07] bg-white dark:border-white/[0.07] dark:bg-zinc-900"
      >
        <header className="flex items-start justify-between gap-3 border-b border-zinc-950/[0.07] p-4 dark:border-white/[0.07]">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Badge tone={scoreTone(score)} icon={<ShieldAlert className="h-3 w-3" />}>
                {score.toFixed(2)}
              </Badge>
              {row.verdict && <Badge tone="neutral">{row.verdict}</Badge>}
              {row.blocked && <Badge tone="critical">blocked</Badge>}
            </div>
            <p className="mt-1.5 break-all font-mono text-[12px] text-zinc-700 dark:text-zinc-300">
              {row.method} {row.path}
            </p>
          </div>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Close
          </Button>
        </header>

        <div className="flex flex-col gap-4 p-4">
          {error != null && <ProblemAlert error={error} />}

          <Field label="Detected">{formatRelative(row.createdAt)}</Field>
          <Field label="Heuristic score">{row.heuristicScore.toFixed(3)}</Field>
          <Field label="Model score">{row.llmScore === null ? 'not classified' : row.llmScore.toFixed(3)}</Field>
          <Field label="Route">{row.route?.service ?? 'unrouted'}</Field>
          <Field label="Caller">{row.apiKey?.name ?? row.clientIp ?? 'unknown'}</Field>
          <Field label="Request id">
            <span className="break-all font-mono text-[12px]">{row.requestId}</span>
          </Field>
          {row.categories.length > 0 && (
            <Field label="Categories">
              <span className="flex flex-wrap gap-1">
                {row.categories.map((c) => (
                  <Badge key={c}>{c}</Badge>
                ))}
              </span>
            </Field>
          )}
        </div>

        <footer className="mt-auto flex flex-wrap gap-2 border-t border-zinc-950/[0.07] p-4 dark:border-white/[0.07]">
          <Button variant="primary" onClick={() => review.mutate('true_positive')} disabled={review.isPending}>
            Confirm threat
          </Button>
          <Button onClick={() => review.mutate('false_positive')} disabled={review.isPending}>
            False positive
          </Button>
          <Button variant="danger" onClick={() => throttle.mutate()} disabled={throttle.isPending}>
            {throttle.isSuccess ? 'Throttled 10m' : 'Throttle caller'}
          </Button>
        </footer>
      </aside>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="w-32 shrink-0 text-[12px] text-zinc-500 dark:text-zinc-400">{label}</span>
      <span className="min-w-0 flex-1 text-chrome text-zinc-800 dark:text-zinc-200">{children}</span>
    </div>
  );
}
