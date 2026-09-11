import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, KeyRound, RotateCw } from 'lucide-react';
import * as React from 'react';
import { MobilePageTitle, PageHeader } from '@/components/shell/app-shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { DataTable, type Column } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { ProblemAlert } from '@/components/ui/problem-alert';
import { api } from '@/lib/api';
import { formatRelative } from '@/lib/format';
import { type ApiKeyRow, useApiKeys } from '@/lib/queries';

export function ApiKeysPage() {
  const keys = useApiKeys({ pageSize: 100 });
  const queryClient = useQueryClient();
  const [created, setCreated] = React.useState<{ name: string; rawKey: string } | null>(null);
  const [name, setName] = React.useState('');
  const [error, setError] = React.useState<unknown>(null);

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['api-keys'] });

  const create = useMutation({
    mutationFn: (payload: { name: string; scopes: string[] }) =>
      api<ApiKeyRow & { rawKey: string }>('/admin/v1/api-keys', { method: 'POST', body: payload }),
    onSuccess: (key) => {
      setCreated({ name: key.name, rawKey: key.rawKey });
      setName('');
      invalidate();
    },
    onError: setError,
  });

  const rotate = useMutation({
    mutationFn: (id: string) =>
      api<ApiKeyRow & { rawKey: string }>(`/admin/v1/api-keys/${id}/rotate`, { method: 'POST' }),
    onSuccess: (key) => {
      setCreated({ name: key.name, rawKey: key.rawKey });
      invalidate();
    },
    onError: setError,
  });

  const revoke = useMutation({
    mutationFn: (id: string) => api(`/admin/v1/api-keys/${id}`, { method: 'DELETE' }),
    onSuccess: invalidate,
    onError: setError,
  });

  const columns: Column<ApiKeyRow>[] = [
    {
      id: 'name',
      header: 'Name',
      cell: (row) => <span className="font-medium text-zinc-900 dark:text-zinc-100">{row.name}</span>,
    },
    {
      id: 'prefix',
      header: 'Prefix',
      cell: (row) => <span className="font-mono text-[12px] text-zinc-500 dark:text-zinc-400">{row.prefix}</span>,
    },
    {
      id: 'status',
      header: 'Status',
      width: '6rem',
      cell: (row) => (
        <Badge tone={row.status === 'active' ? 'ok' : 'neutral'}>{row.status}</Badge>
      ),
    },
    {
      id: 'scopes',
      header: 'Scopes',
      secondary: true,
      cell: (row) =>
        row.scopes.length === 0 ? (
          <span className="text-zinc-400 dark:text-zinc-600">none</span>
        ) : (
          <span className="flex flex-wrap gap-1">
            {row.scopes.map((s) => (
              <Badge key={s}>{s}</Badge>
            ))}
          </span>
        ),
    },
    {
      id: 'lastUsed',
      header: 'Last used',
      secondary: true,
      width: '8rem',
      cell: (row) => <span className="text-zinc-500 dark:text-zinc-400">{formatRelative(row.lastUsedAt)}</span>,
    },
    {
      id: 'actions',
      header: '',
      align: 'right',
      width: '10rem',
      cell: (row) => (
        <span className="flex justify-end gap-1.5">
          <Button size="sm" variant="ghost" onClick={() => rotate.mutate(row.id)} disabled={rotate.isPending}>
            <RotateCw className="h-3 w-3" aria-hidden /> Rotate
          </Button>
          {row.status === 'active' && (
            <Button size="sm" variant="ghost" className="text-critical" onClick={() => revoke.mutate(row.id)}>
              Revoke
            </Button>
          )}
        </span>
      ),
    },
  ];

  return (
    <>
      <PageHeader title="API keys" description="Machine credentials for the gateway" />
      <MobilePageTitle title="API keys" />

      <div className="flex flex-col gap-4 p-4 lg:p-6">
        {created && <OneTimeSecret name={created.name} rawKey={created.rawKey} onDismiss={() => setCreated(null)} />}
        {error != null && <ProblemAlert error={error} />}

        <Card>
          <form
            className="flex flex-wrap items-end gap-2 border-b border-zinc-950/[0.07] p-3 dark:border-white/[0.07]"
            onSubmit={(e) => {
              e.preventDefault();
              setError(null);
              if (name.trim()) create.mutate({ name: name.trim(), scopes: [] });
            }}
          >
            <div className="flex min-w-[12rem] flex-1 flex-col gap-1">
              <label htmlFor="key-name" className="text-[12px] font-medium text-zinc-600 dark:text-zinc-400">
                New key name
              </label>
              <input
                id="key-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="orders-service"
                className="h-8 rounded-md border border-zinc-950/[0.09] bg-white px-2.5 text-chrome outline-none transition-colors placeholder:text-zinc-400 focus-visible:border-brand-500/60 focus-visible:ring-2 focus-visible:ring-brand-500/30 dark:border-white/[0.09] dark:bg-white/[0.04] dark:text-zinc-100"
              />
            </div>
            <Button type="submit" variant="primary" disabled={!name.trim() || create.isPending}>
              Create key
            </Button>
          </form>

          <DataTable
            columns={columns}
            rows={keys.data?.items ?? []}
            rowKey={(row) => row.id}
            loading={keys.isLoading}
            caption="API keys"
            empty={
              <EmptyState
                icon={<KeyRound className="h-6 w-6" />}
                title="No API keys yet"
                hint="Create one above, then send it as the X-API-Key header."
              />
            }
          />
        </Card>
      </div>
    </>
  );
}

/** The raw key exists exactly once, so the UI says so plainly and makes copying the obvious action. */
function OneTimeSecret({
  name,
  rawKey,
  onDismiss,
}: {
  name: string;
  rawKey: string;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = React.useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(rawKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    } catch {
      /* clipboard blocked: the value is on screen to select manually */
    }
  };

  return (
    <div role="alert" className="rounded-lg border border-brand-500/25 bg-brand-500/[0.07] p-3.5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-chrome font-medium text-zinc-900 dark:text-zinc-100">
            Key for “{name}” created
          </p>
          <p className="mt-0.5 text-[12px] text-zinc-600 dark:text-zinc-400">
            This is the only time the full key is shown. Store it now; only its hash is kept.
          </p>
        </div>
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
      <div className="mt-2.5 flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-md border border-zinc-950/[0.09] bg-white px-2.5 py-1.5 font-mono text-[12px] text-zinc-900 dark:border-white/[0.09] dark:bg-zinc-900 dark:text-zinc-100">
          {rawKey}
        </code>
        <Button variant="primary" onClick={copy}>
          {copied ? <Check className="h-3.5 w-3.5" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
    </div>
  );
}
