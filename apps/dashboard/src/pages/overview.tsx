import { ShieldAlert } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { BarList, LatencyChart, RefusalsChart, RequestsChart } from '@/components/charts/traffic-charts';
import { MobilePageTitle, PageHeader } from '@/components/shell/app-shell';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { KpiCard } from '@/components/ui/kpi-card';
import { ProblemAlert } from '@/components/ui/problem-alert';
import { AutoRefreshToggle, TimeRangePicker } from '@/components/ui/time-range';
import { useRangeState } from '@/hooks/use-range-state';
import { formatCount, formatMs, formatPercent, formatRelative } from '@/lib/format';
import {
  useAnomalies,
  useBreakdown,
  useOverview,
  usePreviousOverview,
  useTimeseries,
} from '@/lib/queries';

export function OverviewPage() {
  const navigate = useNavigate();
  const { range, preset, setPreset, live, setLive } = useRangeState();

  const overview = useOverview(range, live);
  const previous = usePreviousOverview(range, live);
  const series = useTimeseries(range, live);
  const byRoute = useBreakdown(range, 'route', live, 6);
  const byKey = useBreakdown(range, 'api_key', live, 6);
  const recentAnomalies = useAnomalies({ pageSize: 5, minScore: 0.7 }, live);

  const points = series.data?.points ?? [];
  const prev = previous.data;
  const data = overview.data;
  // With no traffic in the previous window every tile would read "new", which says nothing.
  const comparable = (prev?.requests ?? 0) > 0;

  const controls = (
    <>
      <TimeRangePicker value={preset} onChange={setPreset} />
      <AutoRefreshToggle enabled={live} onChange={setLive} updatedAt={overview.dataUpdatedAt} />
    </>
  );

  return (
    <>
      <PageHeader title="Overview" description="Traffic, latency and threats across every route" actions={controls} />
      <MobilePageTitle title="Overview" actions={controls} />

      <div className="flex flex-col gap-4 p-4 lg:p-6">
        {overview.isError && <ProblemAlert error={overview.error} onRetry={() => void overview.refetch()} />}

        {/* Six tiles, ordered the way an operator scans: volume, health, speed, then defence. */}
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 2xl:grid-cols-6">
          <KpiCard
            label="Requests"
            value={formatCount(data?.requests)}
            detail={`${formatCount(data?.requests)} in the last ${preset.label}`}
            current={data?.requests}
            previous={prev?.requests}
            polarity="neutral"
            comparable={comparable}
            spark={points.map((p) => p.requests)}
            loading={overview.isLoading}
          />
          <KpiCard
            label="Error rate"
            value={formatPercent(data?.errorRate)}
            detail="5xx responses"
            current={data?.errorRate}
            previous={prev?.errorRate}
            polarity="less-is-good"
            comparable={comparable}
            spark={points.map((p) => p.errors)}
            sparkColor="var(--color-critical)"
            loading={overview.isLoading}
          />
          <KpiCard
            label="p95 latency"
            value={formatMs(data?.p95)}
            detail={`p50 ${formatMs(data?.p50)}`}
            current={data?.p95}
            previous={prev?.p95}
            polarity="less-is-good"
            comparable={comparable}
            spark={points.map((p) => p.latencyP95)}
            sparkColor="var(--color-latency-high)"
            loading={overview.isLoading}
          />
          <KpiCard
            label="Rate limited"
            value={formatCount(data?.rateLimited)}
            detail="429 responses"
            current={data?.rateLimited}
            previous={prev?.rateLimited}
            polarity="less-is-good"
            comparable={comparable}
            spark={points.map((p) => p.rateLimited)}
            sparkColor="var(--color-series-3)"
            loading={overview.isLoading}
          />
          <KpiCard
            label="Cache hit ratio"
            value={data?.cacheHitRatio === null ? 'n/a' : formatPercent(data?.cacheHitRatio)}
            detail="of cacheable reads"
            current={data?.cacheHitRatio ?? undefined}
            previous={prev?.cacheHitRatio ?? undefined}
            polarity="more-is-good"
            comparable={comparable}
            spark={points.map((p) => p.cacheHits)}
            sparkColor="var(--color-series-2)"
            loading={overview.isLoading}
          />
          <KpiCard
            label="Blocked"
            value={formatCount(data?.blocked)}
            detail={`${formatCount(data?.anomalies)} anomalies flagged`}
            current={data?.blocked}
            previous={prev?.blocked}
            polarity="neutral"
            comparable={comparable}
            loading={overview.isLoading}
          />
        </div>

        <div className="grid gap-4 xl:grid-cols-2">
          <RequestsChart points={points} loading={series.isLoading} live={live} />
          <LatencyChart points={points} loading={series.isLoading} live={live} />
        </div>

        <RefusalsChart points={points} loading={series.isLoading} live={live} />

        <div className="grid gap-4 xl:grid-cols-3">
          <Card>
            <CardHeader title="Top routes" description="By request volume in this range" />
            <BarList
              items={byRoute.data?.items ?? []}
              loading={byRoute.isLoading}
              onSelect={(key) => navigate(`/logs?route=${encodeURIComponent(key)}`)}
            />
          </Card>

          <Card>
            <CardHeader
              title="Top callers"
              description={byKey.data?.sampledLatency ? 'Latency from a sample' : 'By request volume'}
            />
            <BarList items={byKey.data?.items ?? []} loading={byKey.isLoading} emptyHint="No identified callers yet." />
          </Card>

          <Card className="flex flex-col">
            <CardHeader
              title="Recent anomalies"
              description="Scored at or above 0.7"
              actions={
                <button
                  type="button"
                  onClick={() => navigate('/anomalies')}
                  className="rounded px-1.5 py-0.5 text-[12px] text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/70 dark:text-zinc-400 dark:hover:bg-white/[0.06] dark:hover:text-zinc-100"
                >
                  View all
                </button>
              }
            />
            {recentAnomalies.data && recentAnomalies.data.items.length === 0 ? (
              <EmptyState
                icon={<ShieldAlert className="h-6 w-6" />}
                title="Nothing flagged"
                hint="No request scored above the review threshold in this range."
              />
            ) : (
              <ul className="flex flex-col">
                {(recentAnomalies.data?.items ?? []).map((anomaly) => {
                  const score = anomaly.llmScore ?? anomaly.heuristicScore;
                  return (
                    <li key={anomaly.id}>
                      <button
                        type="button"
                        onClick={() => navigate(`/anomalies?id=${anomaly.id}`)}
                        className="flex w-full items-center gap-2.5 px-4 py-2 text-left transition-colors hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500/70 dark:hover:bg-white/[0.03]"
                      >
                        <Badge tone={score >= 0.9 ? 'critical' : score >= 0.7 ? 'serious' : 'warn'}>
                          {score.toFixed(2)}
                        </Badge>
                        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-zinc-700 dark:text-zinc-300">
                          {anomaly.method} {anomaly.path}
                        </span>
                        {anomaly.blocked && <Badge tone="critical">blocked</Badge>}
                        <span className="shrink-0 text-[11px] text-zinc-400 dark:text-zinc-500">
                          {formatRelative(anomaly.createdAt)}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
