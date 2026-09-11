import * as React from 'react';

/** Every chart and table needs one: an empty range must explain itself, not render a blank box. */
export function EmptyState({
  icon,
  title,
  hint,
  action,
}: {
  icon?: React.ReactNode;
  title: string;
  hint?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center">
      {icon && <div className="text-zinc-300 dark:text-zinc-600">{icon}</div>}
      <p className="text-chrome font-medium text-zinc-700 dark:text-zinc-300">{title}</p>
      {hint && <p className="max-w-sm text-[12px] text-zinc-500 dark:text-zinc-400">{hint}</p>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
