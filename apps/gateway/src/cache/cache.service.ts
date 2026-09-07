import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { RedisService } from '../redis/redis.service.js';
import { cacheLockKey } from './cache-key.js';

/** What lives under `cache:{routeId}:{hash}` (docs/04 §5). */
export interface CacheEntry {
  status: number;
  headers: Record<string, string>;
  /** base64 of the exact bytes sent to the client (already content-encoded if the upstream compressed). */
  bodyB64: string;
  storedAt: number;
}

export const LOCK_TTL_MS = 2_000;
export const LOCK_WAIT_MS = 200;
export const LOCK_POLL_MS = 25;
const PURGE_CHUNK = 500;
/** Index TTL trails the longest entry so an abandoned route does not pin a set forever. */
const INDEX_GRACE_S = 60;

@Injectable()
export class CacheService {
  constructor(
    private readonly redis: RedisService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(CacheService.name);
  }

  async get(key: string): Promise<CacheEntry | null> {
    const raw = await this.redis.safe('cache get', (c) => c.get(key), null);
    if (!raw) return null;
    try {
      const entry = JSON.parse(raw) as CacheEntry;
      return typeof entry.status === 'number' &&
        typeof entry.bodyB64 === 'string'
        ? entry
        : null;
    } catch {
      return null;
    }
  }

  async store(
    key: string,
    indexKey: string,
    ttlSeconds: number,
    entry: CacheEntry,
  ): Promise<void> {
    await this.redis.safe(
      'cache store',
      async (c) => {
        await c
          .multi()
          .set(key, JSON.stringify(entry), 'EX', ttlSeconds)
          .sadd(indexKey, key)
          .expire(indexKey, ttlSeconds + INDEX_GRACE_S)
          .exec();
      },
      undefined,
    );
  }

  /** docs/05 §2.4: first MISS takes a short lock; followers wait briefly for the entry, then go upstream anyway. */
  async acquireLock(key: string): Promise<boolean> {
    const ok = await this.redis.safe(
      'cache lock',
      (c) => c.set(cacheLockKey(key), '1', 'PX', LOCK_TTL_MS, 'NX'),
      'OK',
    );
    return ok === 'OK';
  }

  async releaseLock(key: string): Promise<void> {
    await this.redis.safe('cache unlock', (c) => c.del(cacheLockKey(key)), 0);
  }

  async waitForEntry(
    key: string,
    maxWaitMs = LOCK_WAIT_MS,
    pollMs = LOCK_POLL_MS,
  ): Promise<CacheEntry | null> {
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, pollMs));
      const entry = await this.get(key);
      if (entry) return entry;
    }
    return null;
  }

  /** docs/05 §2.5: SMEMBERS index -> UNLINK in chunks -> DEL index. Returns the number of entries removed. */
  async purgeRoute(indexKey: string): Promise<number> {
    return this.redis.safe(
      'cache purge',
      async (c) => {
        const keys = await c.smembers(indexKey);
        let deleted = 0;
        for (let i = 0; i < keys.length; i += PURGE_CHUNK) {
          deleted += await c.unlink(...keys.slice(i, i + PURGE_CHUNK));
        }
        await c.del(indexKey);
        return deleted;
      },
      0,
    );
  }
}
