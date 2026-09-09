import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { RedisService } from '../../redis/redis.service.js';
import type { FeatureEnvelope } from '../envelope.js';
import type { Verdict } from './provider.js';

export const BREAKER_FAILURE_THRESHOLD = 5;
export const BREAKER_OPEN_SECONDS = 60;
export const DEDUP_TTL_SECONDS = 600;
const COUNTER_TTL_SECONDS = 2 * 24 * 3600;

const breakerFailuresKey = 'cb:llm:failures';
const breakerOpenKey = 'cb:llm:open';
const dailyCallsKey = (day: string): string => `llm:calls:${day}`;
const verdictKey = (hash: string): string => `llm:verdict:${hash}`;

export function utcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10).replace(/-/g, '');
}

/** Same sender repeating the same payload within 10 minutes reuses the verdict (docs/06 section 6.3). */
export function dedupHash(envelope: FeatureEnvelope): string {
  return createHash('sha1')
    .update(envelope.principal)
    .update(' ')
    .update(envelope.path)
    .update(' ')
    .update(envelope.querySample)
    .update(' ')
    .update(envelope.bodySample)
    .digest('hex');
}

export type SkipReason = 'circuit_open' | 'daily_cap';

/**
 * The cost and stability envelope around the model (docs/06 section 6.3): a shared circuit breaker,
 * a daily call cap and a short-lived verdict cache. All state lives in Redis so replicas agree;
 * every call degrades to "allow, uncached" when Redis is unavailable.
 */
@Injectable()
export class LlmGuardrails {
  constructor(
    private readonly redis: RedisService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(LlmGuardrails.name);
  }

  async cachedVerdict(hash: string): Promise<Verdict | null> {
    const raw = await this.redis.safe(
      'llm verdict cache',
      (c) => c.get(verdictKey(hash)),
      null,
    );
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Verdict;
    } catch {
      return null;
    }
  }

  async cacheVerdict(hash: string, verdict: Verdict): Promise<void> {
    await this.redis.safe(
      'llm verdict cache write',
      (c) =>
        c.set(
          verdictKey(hash),
          JSON.stringify(verdict),
          'EX',
          DEDUP_TTL_SECONDS,
        ),
      null,
    );
  }

  /** Breaker open, or the daily budget already spent, means "skip the model and keep the heuristic score". */
  async blockedReason(
    dailyCap: number,
    now = new Date(),
  ): Promise<SkipReason | null> {
    const open = await this.redis.safe(
      'llm breaker',
      (c) => c.exists(breakerOpenKey),
      0,
    );
    if (open === 1) return 'circuit_open';
    if (dailyCap <= 0) return 'daily_cap';
    const used = await this.redis.safe(
      'llm daily calls',
      (c) => c.get(dailyCallsKey(utcDay(now))),
      null,
    );
    return Number(used ?? 0) >= dailyCap ? 'daily_cap' : null;
  }

  /** Counted before the call so a crash cannot make the budget drift upward. */
  async countCall(now = new Date()): Promise<number> {
    const key = dailyCallsKey(utcDay(now));
    return this.redis.safe(
      'llm daily counter',
      async (c) => {
        const results =
          (await c.multi().incr(key).expire(key, COUNTER_TTL_SECONDS).exec()) ??
          [];
        return Number(results[0]?.[1] ?? 0);
      },
      0,
    );
  }

  async callsToday(now = new Date()): Promise<number> {
    const used = await this.redis.safe(
      'llm daily calls',
      (c) => c.get(dailyCallsKey(utcDay(now))),
      null,
    );
    return Number(used ?? 0);
  }

  async recordSuccess(): Promise<void> {
    await this.redis.safe(
      'llm breaker reset',
      (c) => c.del(breakerFailuresKey),
      0,
    );
  }

  /** Five consecutive failures open the breaker for 60 s; half-open is simply the next call after it expires. */
  async recordFailure(): Promise<boolean> {
    const failures = await this.redis.safe(
      'llm breaker increment',
      async (c) => {
        const results =
          (await c
            .multi()
            .incr(breakerFailuresKey)
            .expire(breakerFailuresKey, BREAKER_OPEN_SECONDS * 5)
            .exec()) ?? [];
        return Number(results[0]?.[1] ?? 0);
      },
      0,
    );
    if (failures < BREAKER_FAILURE_THRESHOLD) return false;
    await this.redis.safe(
      'llm breaker open',
      async (c) => {
        await c
          .multi()
          .set(breakerOpenKey, '1', 'EX', BREAKER_OPEN_SECONDS)
          .del(breakerFailuresKey)
          .exec();
      },
      null,
    );
    this.logger.warn(
      { failures, open_seconds: BREAKER_OPEN_SECONDS },
      'llm circuit breaker opened',
    );
    return true;
  }
}
