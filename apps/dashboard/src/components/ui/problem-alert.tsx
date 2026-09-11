import { AlertTriangle } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { Button } from './button';

/**
 * Renders an RFC 7807 problem the way the gateway returns it: title as the headline, `detail` as the
 * explanation, and the request id so an operator can find the exact request in the log explorer.
 */
export function ProblemAlert({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const isApi = error instanceof ApiError;
  const title = isApi ? (error.problem.title ?? 'Request failed') : 'Something went wrong';
  const detail = isApi
    ? (error.problem.detail ?? error.message)
    : error instanceof Error
      ? error.message
      : String(error);
  const requestId = isApi ? error.problem.requestId : undefined;

  return (
    <div
      role="alert"
      className="flex items-start gap-2.5 rounded-md border border-critical/25 bg-critical/[0.06] px-3 py-2.5"
    >
      <AlertTriangle className="mt-px h-4 w-4 shrink-0 text-critical" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-chrome font-medium text-zinc-900 dark:text-zinc-100">{title}</p>
        <p className="mt-0.5 text-[12px] text-zinc-600 dark:text-zinc-400">{detail}</p>
        {requestId && (
          <p className="mt-1 font-mono text-[11px] text-zinc-400 dark:text-zinc-500">
            request {requestId}
          </p>
        )}
      </div>
      {onRetry && (
        <Button size="sm" variant="ghost" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}
