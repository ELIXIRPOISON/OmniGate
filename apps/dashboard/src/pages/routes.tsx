import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, RefreshCw, Route as RouteIcon, Trash2 } from 'lucide-react';
import * as React from 'react';
import { MobilePageTitle, PageHeader } from '@/components/shell/app-shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { DataTable, type Column } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { ConfirmDialog, Modal } from '@/components/ui/modal';
import { ProblemAlert } from '@/components/ui/problem-alert';
import { api } from '@/lib/api';
import { formatMs } from '@/lib/format';
import { type RouteRow, usePolicies, useRoutes } from '@/lib/queries';
import { cn } from '@/lib/utils';

export function RoutesPage() {
  const routes = useRoutes();
  const queryClient = useQueryClient();
  const [error, setError] = React.useState<unknown>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [editing, setEditing] = React.useState<RouteRow | 'new' | null>(null);
  const [deleting, setDeleting] = React.useState<RouteRow | null>(null);

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
    onSuccess: () => {
      setNotice(`Route "${deleting?.service}" deleted. Traffic to it now 404s.`);
      setDeleting(null);
      invalidate();
    },
    onError: (e) => {
      setDeleting(null);
      setError(e);
    },
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
      width: '15rem',
      cell: (row) => (
        <span className="flex justify-end gap-1.5">
          <Button size="sm" variant="ghost" onClick={() => purge.mutate(row.id)}>
            Purge
          </Button>
          <Button size="sm" variant="ghost" onClick={() => toggle.mutate({ id: row.id, enabled: !row.enabled })}>
            {row.enabled ? 'Disable' : 'Enable'}
          </Button>
          <Button size="sm" variant="ghost" aria-label={`Edit ${row.service}`} onClick={() => setEditing(row)}>
            <Pencil className="h-3 w-3" aria-hidden />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-critical"
            aria-label={`Delete ${row.service}`}
            onClick={() => setDeleting(row)}
          >
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
          <>
            <Button variant="ghost" onClick={() => reload.mutate()} disabled={reload.isPending}>
              <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Reload registry
            </Button>
            <Button variant="primary" onClick={() => setEditing('new')}>
              <Plus className="h-3.5 w-3.5" aria-hidden /> Add route
            </Button>
          </>
        }
      />
      <MobilePageTitle title="Routes" actions={<Button variant="primary" size="sm" onClick={() => setEditing('new')}>Add</Button>} />

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
                title="No routes yet"
                hint="A route points /api/{service} at an upstream and decides how it is protected."
                action={
                  <Button variant="primary" onClick={() => setEditing('new')}>
                    <Plus className="h-3.5 w-3.5" aria-hidden /> Add your first route
                  </Button>
                }
              />
            }
          />
        </Card>

        <p className="text-[12px] text-zinc-500 dark:text-zinc-400">
          Routes defined in <code className="font-mono">routes.yaml</code> also serve traffic and are not listed
          here. A database route with the same service name takes precedence.
        </p>
      </div>

      <RouteForm
        target={editing}
        onClose={() => setEditing(null)}
        onSaved={(service, created) => {
          setEditing(null);
          setNotice(`Route "${service}" ${created ? 'created' : 'updated'} and in force.`);
          invalidate();
        }}
      />

      <ConfirmDialog
        key={deleting?.id ?? 'none'}
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
        title={`Delete route "${deleting?.service}"?`}
        description={
          <>
            Requests to <code className="font-mono">/api/{deleting?.service}</code> will start returning 404
            immediately. This cannot be undone.
          </>
        }
        confirmLabel="Delete route"
        confirmWord={deleting?.service}
        pending={remove.isPending}
      />
    </>
  );
}

/* ---- the form ------------------------------------------------------------------------------- */

interface Draft {
  service: string;
  upstream: string;
  stripPrefix: boolean;
  methods: string;
  authRequired: boolean;
  scopes: string;
  policyId: string;
  cacheTtlSeconds: string;
  anomalyMode: 'off' | 'async' | 'sync';
  timeoutMs: string;
  enabled: boolean;
}

const BLANK: Draft = {
  service: '',
  upstream: '',
  stripPrefix: true,
  methods: '*',
  authRequired: true,
  scopes: '',
  policyId: '',
  cacheTtlSeconds: '0',
  anomalyMode: 'async',
  timeoutMs: '30000',
  enabled: true,
};

const toDraft = (row: RouteRow): Draft => ({
  service: row.service,
  upstream: row.upstream,
  stripPrefix: row.stripPrefix,
  methods: row.methods.join(', '),
  authRequired: row.authRequired,
  scopes: row.scopes.join(', '),
  policyId: row.policyId ?? '',
  cacheTtlSeconds: String(row.cacheTtlSeconds),
  anomalyMode: row.anomalyMode,
  timeoutMs: String(row.timeoutMs),
  enabled: row.enabled,
});

const list = (value: string): string[] =>
  value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * Create and edit in one dialog. Adding a service is the defining operator action for a gateway, so
 * it belongs in the UI rather than in a curl command.
 *
 * The fields mirror `createRouteBody` in the admin API. Validation stays on the server: the form
 * checks only what it can check instantly, and anything else comes back as a problem+json detail.
 */
function RouteForm({
  target,
  onClose,
  onSaved,
}: {
  target: RouteRow | 'new' | null;
  onClose: () => void;
  onSaved: (service: string, created: boolean) => void;
}) {
  const creating = target === 'new';
  const row = target && target !== 'new' ? target : null;
  const policies = usePolicies();
  const [draft, setDraft] = React.useState<Draft>(BLANK);
  const [error, setError] = React.useState<unknown>(null);

  React.useEffect(() => {
    if (!target) return;
    setError(null);
    setDraft(row ? toDraft(row) : BLANK);
  }, [target, row]);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const save = useMutation({
    mutationFn: () => {
      const body = {
        service: draft.service.trim(),
        upstream: draft.upstream.trim(),
        stripPrefix: draft.stripPrefix,
        methods: list(draft.methods).length ? list(draft.methods) : ['*'],
        authRequired: draft.authRequired,
        scopes: list(draft.scopes),
        policyId: draft.policyId || null,
        cacheTtlSeconds: Number(draft.cacheTtlSeconds) || 0,
        anomalyMode: draft.anomalyMode,
        timeoutMs: Number(draft.timeoutMs) || 30_000,
        enabled: draft.enabled,
      };
      return creating
        ? api('/admin/v1/routes', { method: 'POST', body })
        : api(`/admin/v1/routes/${row?.id}`, { method: 'PATCH', body });
    },
    onSuccess: () => onSaved(draft.service.trim(), creating),
    onError: setError,
  });

  // The server owns the real rules; this only gates the submit button on the two that are obvious.
  const serviceOk = /^[a-z0-9][a-z0-9-]{0,62}$/.test(draft.service.trim());
  const valid = serviceOk && draft.upstream.trim().length > 0;

  return (
    <Modal
      open={target !== null}
      onClose={onClose}
      size="lg"
      title={creating ? 'Add route' : `Edit ${row?.service}`}
      description={
        creating
          ? 'Traffic to /api/{service} is proxied to the upstream you name here.'
          : 'Changes take effect as soon as you save; the registry reloads itself.'
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!valid || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? 'Saving…' : creating ? 'Create route' : 'Save changes'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {error != null && <ProblemAlert error={error} />}

        <div className="grid grid-cols-2 gap-3">
          <Field
            label="Service"
            hint={
              draft.service && !serviceOk
                ? 'Lowercase letters, digits and hyphens only'
                : draft.service
                  ? `Reachable at /api/${draft.service.trim()}`
                  : 'Used as the URL segment'
            }
            invalid={Boolean(draft.service) && !serviceOk}
          >
            <input
              value={draft.service}
              onChange={(e) => set('service', e.target.value)}
              placeholder="orders"
              autoComplete="off"
              spellCheck={false}
              className={inputClass}
            />
          </Field>

          <Field label="Upstream" hint="Scheme and host the request is proxied to">
            <input
              value={draft.upstream}
              onChange={(e) => set('upstream', e.target.value)}
              placeholder="http://orders:3000"
              autoComplete="off"
              spellCheck={false}
              className={inputClass}
            />
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Methods" hint="Comma separated, or * for all">
            <input value={draft.methods} onChange={(e) => set('methods', e.target.value)} className={inputClass} />
          </Field>
          <Field label="Rate limit policy" hint="Falls back to the environment default">
            <select
              value={draft.policyId}
              onChange={(e) => set('policyId', e.target.value)}
              className={inputClass}
            >
              <option value="">Default</option>
              {(policies.data?.items ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} — {p.maxRequests}/{p.windowSeconds}s
                </option>
              ))}
            </select>
          </Field>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <Field label="Cache TTL" hint="Seconds; 0 disables">
            <input
              type="number"
              min={0}
              max={86400}
              value={draft.cacheTtlSeconds}
              onChange={(e) => set('cacheTtlSeconds', e.target.value)}
              className={inputClass}
            />
          </Field>
          <Field label="Screening" hint="sync refuses inline">
            <select
              value={draft.anomalyMode}
              onChange={(e) => set('anomalyMode', e.target.value as Draft['anomalyMode'])}
              className={inputClass}
            >
              <option value="off">off</option>
              <option value="async">async</option>
              <option value="sync">sync</option>
            </select>
          </Field>
          <Field label="Timeout" hint="Milliseconds">
            <input
              type="number"
              min={100}
              max={600000}
              value={draft.timeoutMs}
              onChange={(e) => set('timeoutMs', e.target.value)}
              className={inputClass}
            />
          </Field>
        </div>

        <Field
          label="Required scopes"
          hint="Comma separated. Naming any scope implies authentication."
        >
          <input
            value={draft.scopes}
            onChange={(e) => set('scopes', e.target.value)}
            placeholder="orders:read"
            autoComplete="off"
            spellCheck={false}
            className={inputClass}
          />
        </Field>

        <div className="flex flex-col gap-2 pt-1">
          <Toggle
            checked={draft.authRequired}
            onChange={(v) => set('authRequired', v)}
            label="Require authentication"
            hint="A JWT or API key must be presented"
          />
          <Toggle
            checked={draft.stripPrefix}
            onChange={(v) => set('stripPrefix', v)}
            label="Strip the /api/{service} prefix"
            hint="The upstream sees /items, not /api/orders/items"
          />
          <Toggle
            checked={draft.enabled}
            onChange={(v) => set('enabled', v)}
            label="Enabled"
            hint="Disabled routes return 404"
          />
        </div>
      </div>
    </Modal>
  );
}

const inputClass =
  'h-8 w-full rounded-md border border-zinc-950/[0.09] bg-white px-2 text-chrome text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/70 dark:border-white/[0.09] dark:bg-white/[0.04] dark:text-zinc-100';

function Field({
  label,
  hint,
  invalid,
  children,
}: {
  label: string;
  hint?: string;
  invalid?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[12px] font-medium text-zinc-700 dark:text-zinc-300">{label}</span>
      {children}
      {hint && (
        <span className={cn('text-[11px]', invalid ? 'text-critical' : 'text-zinc-500 dark:text-zinc-400')}>
          {hint}
        </span>
      )}
    </label>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-3.5 w-3.5 accent-brand-600"
      />
      <span className="flex flex-col">
        <span className="text-chrome text-zinc-800 dark:text-zinc-200">{label}</span>
        <span className="text-[11px] text-zinc-500 dark:text-zinc-400">{hint}</span>
      </span>
    </label>
  );
}
