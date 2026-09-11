import * as React from 'react';
import { cn } from '@/lib/utils';

export type BadgeTone = 'neutral' | 'ok' | 'warn' | 'serious' | 'critical' | 'brand';

const tones: Record<BadgeTone, string> = {
  neutral:
    'border-zinc-950/[0.09] bg-zinc-100 text-zinc-600 dark:border-white/[0.09] dark:bg-white/[0.06] dark:text-zinc-300',
  ok: 'border-ok/25 bg-ok/10 text-ok',
  warn: 'border-warn/30 bg-warn/10 text-warn',
  serious: 'border-serious/30 bg-serious/10 text-serious',
  critical: 'border-critical/25 bg-critical/10 text-critical',
  brand: 'border-brand-500/25 bg-brand-500/10 text-brand-700 dark:text-brand-300',
};

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  /** A glyph beside the label, so state is never carried by colour alone. */
  icon?: React.ReactNode;
}

export function Badge({ tone = 'neutral', icon, className, children, ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] font-medium leading-[1.4]',
        tones[tone],
        className,
      )}
      {...props}
    >
      {icon && (
        <span className="shrink-0" aria-hidden>
          {icon}
        </span>
      )}
      {children}
    </span>
  );
}

/** HTTP status class as a badge. The numeral carries the meaning; colour only reinforces it. */
export function StatusBadge({ status }: { status: number }) {
  const tone: BadgeTone =
    status >= 500 ? 'critical' : status >= 400 ? 'warn' : status >= 300 ? 'neutral' : 'ok';
  return (
    <Badge tone={tone} className="tabular">
      {status}
    </Badge>
  );
}
