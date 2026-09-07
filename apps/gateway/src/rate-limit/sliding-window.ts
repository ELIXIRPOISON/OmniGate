import { readFileSync } from 'node:fs';
import type { Redis, Result } from 'ioredis';

/** The Lua source is shipped next to the compiled file (nest-cli.json copies *.lua into dist). */
export const SLIDING_WINDOW_LUA = readFileSync(
  new URL('./lua/sliding_window.lua', import.meta.url),
  'utf8',
);

export interface BucketSpec {
  key: string;
  windowMs: number;
  max: number;
}

export interface BucketOutcome {
  remaining: number;
  resetMs: number;
  retryAfterMs: number;
}

export type SlidingWindowDecision =
  { throttledForMs: number } | { allowed: boolean; buckets: BucketOutcome[] };

declare module 'ioredis' {
  interface RedisCommander<Context> {
    /** Dynamic key count: first argument is the number of keys (throttle key + buckets). */
    slidingWindow(
      numKeys: number,
      ...args: Array<string | number>
    ): Result<number[], Context>;
  }
}

/** Register the script once per client; ioredis runs it via EVALSHA and falls back to EVAL after a Redis restart. */
export function registerSlidingWindow(client: Redis): void {
  if (
    typeof (client as unknown as { slidingWindow?: unknown }).slidingWindow ===
    'function'
  )
    return;
  client.defineCommand('slidingWindow', { lua: SLIDING_WINDOW_LUA });
}

/**
 * One round trip: throttle check + every bucket, atomically. When `skipIfCached` is given and that
 * cache key exists, the request is reported as allowed without consuming a slot (RL_COUNT_CACHE_HITS=false).
 */
export async function runSlidingWindow(
  client: Redis,
  throttleKey: string,
  buckets: BucketSpec[],
  nowMs: number,
  member: string,
  skipIfCached?: string,
): Promise<SlidingWindowDecision> {
  const keys = [
    throttleKey,
    ...buckets.map((b) => b.key),
    ...(skipIfCached ? [skipIfCached] : []),
  ];
  const raw = await client.slidingWindow(
    keys.length,
    ...keys,
    nowMs,
    member,
    buckets.length,
    ...buckets.flatMap((b) => [b.windowMs, b.max]),
  );
  return parseSlidingWindowResult(raw, buckets.length);
}

export function parseSlidingWindowResult(
  raw: number[],
  bucketCount: number,
): SlidingWindowDecision {
  const [ttl, allowed] = raw;
  if (ttl > 0 || ttl === -1) return { throttledForMs: ttl };
  if (raw.length !== 2 + bucketCount * 3) {
    throw new Error(
      `sliding window script returned ${raw.length} values for ${bucketCount} bucket(s)`,
    );
  }
  const outcomes: BucketOutcome[] = [];
  for (let i = 0; i < bucketCount; i++) {
    outcomes.push({
      remaining: raw[2 + i * 3],
      resetMs: raw[3 + i * 3],
      retryAfterMs: raw[4 + i * 3],
    });
  }
  return { allowed: allowed === 1, buckets: outcomes };
}
