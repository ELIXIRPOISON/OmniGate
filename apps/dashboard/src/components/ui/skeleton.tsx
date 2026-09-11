import type * as React from 'react';
import { cn } from '@/lib/utils';

/** Loading placeholder. Shape matches the content it replaces so nothing jumps when data lands. */
export function Skeleton({
  className,
  style,
}: {
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div
      aria-hidden
      style={style}
      className={cn('animate-pulse rounded bg-zinc-200/70 dark:bg-white/[0.07]', className)}
    />
  );
}
