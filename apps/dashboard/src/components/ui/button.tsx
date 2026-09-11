import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Buttons follow the reference component: 13px chrome type, 6px radius, hairline borders expressed
 * as low-alpha ink, and `active:scale-[0.98]` so a press feels physical.
 */
const button = cva(
  [
    'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium',
    'text-chrome leading-none transition-colors',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/70',
    'active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50',
  ].join(' '),
  {
    variants: {
      variant: {
        primary: 'bg-brand-600 text-white hover:bg-brand-700 dark:bg-brand-600 dark:hover:bg-brand-500',
        secondary:
          'border border-zinc-950/[0.09] bg-white text-zinc-800 hover:bg-zinc-100 dark:border-white/[0.09] dark:bg-white/[0.04] dark:text-zinc-100 dark:hover:bg-white/[0.08]',
        ghost:
          'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-white/[0.06] dark:hover:text-zinc-100',
        danger:
          'border border-critical/30 bg-critical/10 text-critical hover:bg-critical/15 dark:bg-critical/15',
        dashed:
          'border border-dashed border-zinc-300 text-zinc-600 hover:border-zinc-400 hover:bg-zinc-100 hover:text-zinc-900 dark:border-zinc-700 dark:text-zinc-400 dark:hover:border-zinc-600 dark:hover:bg-white/[0.06] dark:hover:text-zinc-100',
      },
      size: {
        sm: 'h-7 px-2',
        md: 'h-8 px-2.5',
        lg: 'h-9 px-3.5',
        icon: 'h-7 w-7 p-0',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof button> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, type = 'button', ...props },
  ref,
) {
  return <button ref={ref} type={type} className={cn(button({ variant, size }), className)} {...props} />;
});
