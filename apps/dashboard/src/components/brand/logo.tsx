import { cn } from '@/lib/utils';
import { GATE_PATH, LOCKUP_VIEWBOX, MARK_PATH, MARK_VIEWBOX, OMNI_PATH } from './logo-paths';

/*
 * The supplied artwork (src/assets/logo.png) is a raster on a transparent ground. It is used as-is
 * for the README banner, but the app needs the mark at 20px in the rail and at banner size on the
 * login screen, in two themes. So the artwork is traced to outlines by tools/trace-logo.mjs and the
 * outlines are filled from the theme's brand token. Nothing here is drawn by hand: the paths are the
 * artwork's own contours.
 */

/** The disc and door on their own. Sized by the caller; the aspect ratio is preserved. */
export function Mark({ className }: { className?: string }) {
  return (
    <svg
      viewBox={MARK_VIEWBOX}
      className={cn('h-6 w-6', className)}
      role="img"
      aria-label="OmniGate"
    >
      <path d={MARK_PATH} fillRule="evenodd" className="fill-brand-600 dark:fill-brand-400" />
    </svg>
  );
}

/**
 * The full lockup: mark plus wordmark, as one drawing. The wordmark is the artwork's own lettering
 * rather than the system font set to look similar, so the two never drift apart.
 *
 * Give it a height; the width follows.
 */
export function Wordmark({ className }: { className?: string }) {
  return (
    <svg
      viewBox={LOCKUP_VIEWBOX}
      className={cn('h-8 w-auto', className)}
      role="img"
      aria-label="OmniGate"
    >
      <g className="fill-brand-600 dark:fill-brand-400">
        <path d={MARK_PATH} fillRule="evenodd" />
        <path d={GATE_PATH} fillRule="evenodd" />
      </g>
      <path d={OMNI_PATH} fillRule="evenodd" className="fill-zinc-900 dark:fill-zinc-50" />
    </svg>
  );
}
