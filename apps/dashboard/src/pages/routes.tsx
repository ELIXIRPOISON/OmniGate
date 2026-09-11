import { useMutation, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, Route as RouteIcon, Trash2 } from 'lucide-react';
import * as React from 'react';
import { MobilePageTitle, PageHeader } from '@/components/shell/app-shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { DataTable, type Column } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { ProblemAlert } from '@/components/ui/problem-alert';
import { api } from '@/lib/api';
import { formatMs } from '@/lib/format';
import { type RouteRow, useRoutes } from '@/lib/queries';

export function RoutesPage() {
  const routes = useRoutes();
  const queryClient = useQueryClient();
  const [error, setError] = React.useState<unknown>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['routes'] });

  const purge = useMutation({
    mutationFn: (id: string) =>
      api<{ deletedKeys: number }>(`/admin/v1/routes/${id}/cache/purge`, { method: 'POST' }),
    onSuccess: (result) => setNotice(`Purged ${result.deletedKeys} cache entr${result.deletedKeys === 1 ? 'y' : 'ies'}.`),
    onError: setError,
  });

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api(`/admin/v1/routes/${id}`, { method: 'PATCH', body: { enabled } }),
    onSuccess: invalidate,
    onError: setError,
  });

  const remove = useMutation({
    mutationFn: (id: string) => api(`/admin/v1/routes/${id}`, { method: 'DELETE' }),
    onSuccess: invalidate,
    onError: setError,
  });

  const reload = useMutation({
    mutationFn: () => api<{ routes: number }>('/admin/v1/routes/reload', { method: 'POST' }),
    onSuccess: (result) => {
      setNotice(`Registry reloaded: ${result.routes} routes in force.`);
      invalidate();
    },
    onError: setError,
  });

  const columns: Column<RouteRow>[] = [
    {
      id: 'service',
      header: 'Service',
      cell: (row) => (
        <span className="flex items-center gap-2">
          <span className="font-medium text-zinc-900 dark:text-zinc-100">{row.service}</span>
          {!row.enabled && <Badge>disabled</Badge>}
        </span>
      ),
    },
    {
      id: 'upstream',
      header: 'Upstream',
      cell: (row) => <span className="truncate font-mono text-[12px] text-zinc-500 dark:text-zinc-400">{row.upstream}</span>,
    },
    {
      id: 'auth',
      header: 'Auth',
      width: '6rem',
      cell: (row) => <Badge tone={row.authRequired ? 'brand' : 'neutral'}>{row.authRequired ? 'required' : 'open'}</Badge>,
    },
    {
      id: 'cache',
      header: 'Cache',
      secondary: true,
      width: '6rem',
      cell: (row) =>
        row.cacheTtlSeconds > 0 ? `${row.cacheTtlSeconds}s` : <span className="text-zinc-400 dark:text-zinc-600">off</span>,
    },
    {
      id: 'anomaly',
      header: 'Screening',
      secondary: true,
      width: '7rem',
      cell: (row) => (
        <Badge tone={row.anomalyMode === 'sync' ? 'serious' : row.anomalyMode === 'off' ? 'neutral' : 'brand'}>
          {row.anomalyMode}
        </Badge>
      ),
    },
    {
      id: 'timeout',
      header: 'Timeout',
      secondary: true,
      align: 'right',
      width: '5.5rem',
      cell: (row) => formatMs(row.timeoutMs),
    },
    {
      id: 'actions',
      header: '',
      align: 'right',
      width: '13rem',
      cell: (row) => (
        <span className="flex justify-end gap-1.5">
          <Button size="sm" variant="ghost" onClick={() => purge.mutate(row.id)}>
            Purge
          </Button>
          <Button size="sm" variant="ghost" onClick={() => toggle.mutate({ id: row.id, enabled: !row.enabled })}>
            {row.enabled ? 'Disable' : 'Enable'}
          </Button>
          <Button size="sm" variant="ghost" className="text-critical" aria-label={`Delete ${row.service}`} onClick={() => remove.mutate(row.id)}>
            <Trash2 className="h-3 w-3" aria-hidden />
          </Button>
        </span>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Routes"
        description="Where /api/{service} goes, and how it is protected"
        actions={
          <Button onClick={() => reload.mutate()} disabled={reload.isPending}>
            <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Reload registry
          </Button>
        }
      />
      <MobilePageTitle title="Routes" />

      <div className="flex flex-col gap-4 p-4 lg:p-6">
        {error != null && <ProblemAlert error={error} />}
        {notice && (
          <p className="rounded-md border border-zinc-950/[0.07] bg-zinc-100/70 px-3 py-2 text-[12px] text-zinc-600 dark:border-white/[0.07] dark:bg-white/[0.04] dark:text-zinc-300">
            {notice}
          </p>
        )}

        <Card>
          <DataTable
            columns={columns}
            rows={routes.data?.items ?? []}
            rowKey={(row) => row.id}
            loading={routes.isLoading}
            caption="Routes defined in the database"
            empty={
              <EmptyState
                icon={<RouteIcon className="h-6 w-6" />}
                title="No database routes"
                hint="Routes from routes.yaml still serve traffic. Create one through the admin API to manage it here."
              />
            }
          />
        </Card>

        <p className="text-[12px] text-zinc-500 dark:text-zinc-400">
          Routes defined in <code className="font-mono">routes.yaml</code> also serve traffic and are not listed
          here. A database route with the same service name takes precedence.
        </p>
      </div>
    </>
  );
}
