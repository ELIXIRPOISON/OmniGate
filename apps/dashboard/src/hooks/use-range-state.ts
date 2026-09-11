import * as React from 'react';
import {
  RANGE_PRESETS,
  type RangePreset,
  resolveRange,
  type ResolvedRange,
} from '@/components/ui/time-range';

const KEY = 'omnigate.range';

/**
 * Range plus live-refresh state, shared by every page that shows time series. The window is
 * recomputed on a tick so "last hour" keeps meaning the last hour while the tab stays open.
 */
export function useRangeState(defaultId = '1h') {
  const [preset, setPresetState] = React.useState<RangePreset>(() => {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(KEY);
    } catch {
      stored = null;
    }
    return RANGE_PRESETS.find((p) => p.id === (stored ?? defaultId)) ?? RANGE_PRESETS[1];
  });
  const [live, setLive] = React.useState(true);
  const [now, setNow] = React.useState(() => Date.now());

  const setPreset = React.useCallback((next: RangePreset) => {
    setPresetState(next);
    setNow(Date.now());
    try {
      localStorage.setItem(KEY, next.id);
    } catch {
      /* private mode */
    }
  }, []);

  React.useEffect(() => {
    if (!live) return;
    const id = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(id);
  }, [live]);

  // Round to the bucket so the query key is stable between ticks and the cache is not thrashed.
  const range: ResolvedRange = React.useMemo(() => {
    const bucketMs = preset.bucket === '1h' ? 3_600_000 : preset.bucket === '5m' ? 300_000 : 60_000;
    return resolveRange(preset, Math.floor(now / bucketMs) * bucketMs + bucketMs);
  }, [preset, now]);

  return { range, preset, setPreset, live, setLive };
}
