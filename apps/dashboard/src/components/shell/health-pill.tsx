import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, CircleAlert, CircleDashed } from 'lucide-react';
import type { ReadyzResponse } from '@omnigate/shared';
import { cn } from '@/lib/utils';

/**
 * Gateway readiness, polled slowly. It answers one question an operator always has open: are Redis
 * and Postgres reachable right now? State is carried by an icon and a word, never colour alone.
 */
export function HealthPill() {
  const { data, isError, isLoading } = useQuery({
    queryKey: ['readyz'],
    queryFn: async (): Promise<ReadyzResponse> => {
      const response = await fetch('/readyz');
      return (await response.json()) as ReadyzResponse;
    },
    refetchInterval: 15_000,
    retry: false,
  });

  const down = isError || (data && data.status !== 'ok');
  const Icon = isLoading ? CircleDashed : down ? CircleAlert : CheckCircle2;

  const detail = isLoading
    ? 'checking'
    : isError
      ? 'unreachable'
      : data
        ? [data.redis !== 'ok' && 'redis', data.postgres !== 'ok' && 'postgres']
            .filter(Boolean)
            .join(', ') || `${data.routes} routes`
        : '';

  return (
    <div
      className={cn(
        'flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-[12px]',
        down
          ? 'border-critical/25 bg-critical/[0.07] text-critical'
          : 'border-zinc-950/[0.07] bg-zinc-100/70 text-zinc-600 dark:border-white/[0.07] dark:bg-white/[0.04] dark:text-zinc-300',
      )}
    >
      <Icon className={cn('h-3.5 w-3.5 shrink-0', !down && !isLoading && 'text-ok')} aria-hidden />
      <span className="font-medium">{isLoading ? 'Gateway' : down ? 'Degraded' : 'Healthy'}</span>
      {detail && <span className="ml-auto truncate text-zinc-400 dark:text-zinc-500">{detail}</span>}
    </div>
  );
}
