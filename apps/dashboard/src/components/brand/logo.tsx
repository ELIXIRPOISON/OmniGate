import { cn } from '@/lib/utils';

/**
 * Placeholder brand mark: a gateway aperture with traffic passing through it.
 *
 * This is a stand-in. Drop the real logo at `src/assets/logo.svg`, import it here and delete the
 * inline paths; every colour it uses comes from the `brand` token scale in index.css, so matching
 * the artwork is a change to that one block.
 */
export function Mark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn('h-6 w-6', className)} role="img" aria-label="OmniGate">
      <rect x="1.25" y="1.25" width="29.5" height="29.5" rx="8.5" className="fill-brand-600" />
      {/* the aperture */}
      <path
        d="M16 7.5c-4.6 0-8.3 3.8-8.3 8.5s3.7 8.5 8.3 8.5 8.3-3.8 8.3-8.5S20.6 7.5 16 7.5Zm0 3.1c2.9 0 5.2 2.4 5.2 5.4s-2.3 5.4-5.2 5.4-5.2-2.4-5.2-5.4 2.3-5.4 5.2-5.4Z"
        className="fill-white/90"
      />
      {/* traffic passing through */}
      <path
        d="M4 16h7M21 16h7"
        stroke="currentColor"
        className="text-white/90"
        strokeWidth="2.6"
        strokeLinecap="round"
      />
      <circle cx="16" cy="16" r="2.4" className="fill-white" />
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn('flex items-center gap-2', className)}>
      <Mark />
      <span className="text-[15px] font-semibold tracking-[-0.01em] text-zinc-900 dark:text-zinc-50">
        Omni<span className="text-brand-600 dark:text-brand-400">Gate</span>
      </span>
    </span>
  );
}
