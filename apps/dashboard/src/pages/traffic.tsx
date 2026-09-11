import { LatencyChart, BarList, RefusalsChart, RequestsChart } from '@/components/charts/traffic-charts';
import { MobilePageTitle, PageHeader } from '@/components/shell/app-shell';
import { Card, CardHeader } from '@/components/ui/card';
import { ProblemAlert } from '@/components/ui/problem-alert';
import { AutoRefreshToggle, TimeRangePicker } from '@/components/ui/time-range';
import { useRangeState } from '@/hooks/use-range-state';
import { useBreakdown, useTimeseries } from '@/lib/queries';

/** The same series as the overview, given room to breathe, plus the dimensional breakdowns. */
export function TrafficPage() {
  const { range, preset, setPreset, live, setLive } = useRangeState('6h');
  const series = useTimeseries(range, live);
  const byStatus = useBreakdown(range, 'status', live, 10);
  const byIp = useBreakdown(range, 'client_ip', live, 10);
  const byRoute = useBreakdown(range, 'route', live, 10);

  const points = series.data?.points ?? [];
  const controls = (
    <>
      <TimeRangePicker value={preset} onChange={setPreset} />
      <AutoRefreshToggle enabled={live} onChange={setLive} updatedAt={series.dataUpdatedAt} />
    </>
  );

  return (
    <>
      <PageHeader title="Traffic" description="Volume, latency and who is calling" actions={controls} />
      <MobilePageTitle title="Traffic" actions={controls} />

      <div className="flex flex-col gap-4 p-4 lg:p-6">
        {series.isError && <ProblemAlert error={series.error} onRetry={() => void series.refetch()} />}

        <RequestsChart points={points} loading={series.isLoading} live={live} />
        <div className="grid gap-4 xl:grid-cols-2">
          <LatencyChart points={points} loading={series.isLoading} live={live} />
          <RefusalsChart points={points} loading={series.isLoading} live={live} />
        </div>

        <div className="grid gap-4 xl:grid-cols-3">
          <Card>
            <CardHeader title="By route" />
            <BarList items={byRoute.data?.items ?? []} loading={byRoute.isLoading} />
          </Card>
          <Card>
            <CardHeader title="By status code" />
            <BarList items={byStatus.data?.items ?? []} loading={byStatus.isLoading} />
          </Card>
          <Card>
            <CardHeader title="By client IP" description="Top 10 in this range" />
            <BarList items={byIp.data?.items ?? []} loading={byIp.isLoading} />
          </Card>
        </div>
      </div>
    </>
  );
}
