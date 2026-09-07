import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { Principal } from '@omnigate/shared';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { RateLimitPolicyRef } from '../rate-limit/policy.js';
import { RedisService } from '../redis/redis.service.js';
import {
  hashApiKey,
  hashesMatch,
  isApiKeyFormat,
  lookupPrefixOf,
} from './api-key.js';
import { AuthError } from './auth-error.js';

/** What the read-through cache holds per prefix (docs/04 §5 `key:{prefix}` HASH). */
export interface CachedApiKey {
  id: string;
  keyHash: string;
  status: 'active' | 'revoked';
  scopes: string[];
  policyId: string | null;
  /** The key's rate-limit policy row, denormalised so the guard needs no second lookup. */
  policy: RateLimitPolicyRef | null;
  /** ISO timestamp or null. */
  expiresAt: string | null;
}

export interface AuthenticatedApiKey {
  principal: Principal;
  policy: RateLimitPolicyRef | null;
}

export const KEY_CACHE_TTL_S = 60;
export const LAST_USED_MIN_INTERVAL_MS = 60_000;

/** Minimal store interface so the service is unit-testable without Prisma. */
export interface ApiKeyStore {
  findByPrefix(prefix: string): Promise<CachedApiKey | null>;
  markUsed(id: string, at: Date): Promise<void>;
}

@Injectable()
export class ApiKeyService {
  private readonly store: ApiKeyStore;
  private readonly lastTouched = new Map<string, number>();

  constructor(
    @Inject(ENV) private readonly env: Env,
    prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ApiKeyService.name);
    this.store = prismaStore(prisma);
  }

  /** X-API-Key -> principal (+ its policy). 401 reasons: malformed/invalid; 403: revoked/key_expired; 503: unavailable. */
  async authenticate(rawKey: string): Promise<AuthenticatedApiKey> {
    if (!isApiKeyFormat(rawKey))
      throw new AuthError('malformed', 'Malformed API key');
    const prefix = lookupPrefixOf(rawKey);
    const record = await this.lookup(prefix);
    if (
      !record ||
      !hashesMatch(record.keyHash, hashApiKey(rawKey, this.env.API_KEY_PEPPER))
    ) {
      throw new AuthError('invalid', 'Invalid API key');
    }
    if (record.status !== 'active')
      throw new AuthError('revoked', 'API key has been revoked');
    if (record.expiresAt && Date.parse(record.expiresAt) <= Date.now()) {
      throw new AuthError('key_expired', 'API key has expired');
    }
    this.touch(record.id);
    return {
      principal: { type: 'api_key', id: record.id, scopes: record.scopes },
      policy: record.policy,
    };
  }

  /** Drop the cached record so a revoke/rotate takes effect immediately (docs/09 auth table). */
  async invalidate(prefix: string): Promise<void> {
    await this.redis.safe('key invalidate', (c) => c.del(cacheKey(prefix)), 0);
  }

  private async lookup(prefix: string): Promise<CachedApiKey | null> {
    const cached = await this.redis.safe(
      'key lookup',
      (c) => c.hgetall(cacheKey(prefix)),
      null,
    );
    if (cached && Object.keys(cached).length > 0) {
      return cached.missing ? null : fromHash(cached);
    }

    let record: CachedApiKey | null;
    try {
      record = await this.store.findByPrefix(prefix);
    } catch (err) {
      this.logger.error({ err, prefix }, 'api key lookup failed');
      throw new AuthError('unavailable', 'Credential store unavailable');
    }

    // Negative results are cached too, so a brute-force burst does not turn into a DB flood (T2).
    await this.redis.safe(
      'key cache',
      async (c) => {
        const key = cacheKey(prefix);
        await c
          .multi()
          .del(key)
          .hset(key, record ? toHash(record) : { missing: '1' })
          .expire(key, KEY_CACHE_TTL_S)
          .exec();
      },
      undefined,
    );
    return record;
  }

  /** lastUsedAt is written at most once per minute per key, off the request path. */
  private touch(id: string): void {
    const now = Date.now();
    if (now - (this.lastTouched.get(id) ?? 0) < LAST_USED_MIN_INTERVAL_MS)
      return;
    this.lastTouched.set(id, now);
    this.store.markUsed(id, new Date(now)).catch((err: unknown) => {
      this.lastTouched.delete(id);
      this.logger.warn({ err, api_key_id: id }, 'failed to update lastUsedAt');
    });
  }
}

export function cacheKey(prefix: string): string {
  return `key:${prefix}`;
}

export function toHash(record: CachedApiKey): Record<string, string> {
  return {
    id: record.id,
    keyHash: record.keyHash,
    status: record.status,
    scopes: JSON.stringify(record.scopes),
    policyId: record.policyId ?? '',
    policy: record.policy ? JSON.stringify(record.policy) : '',
    expiresAt: record.expiresAt ?? '',
  };
}

export function fromHash(hash: Record<string, string>): CachedApiKey {
  return {
    id: hash.id,
    keyHash: hash.keyHash,
    status: hash.status === 'active' ? 'active' : 'revoked',
    scopes: safeJsonArray(hash.scopes),
    policyId: hash.policyId || null,
    policy: safePolicy(hash.policy),
    expiresAt: hash.expiresAt || null,
  };
}

function safePolicy(value: string | undefined): RateLimitPolicyRef | null {
  if (!value) return null;
  try {
    const p = JSON.parse(value) as Partial<RateLimitPolicyRef>;
    if (
      typeof p.id === 'string' &&
      typeof p.windowSeconds === 'number' &&
      typeof p.maxRequests === 'number'
    ) {
      return {
        id: p.id,
        windowSeconds: p.windowSeconds,
        maxRequests: p.maxRequests,
      };
    }
  } catch {
    /* fall through */
  }
  return null;
}

function safeJsonArray(value: string | undefined): string[] {
  try {
    const parsed: unknown = JSON.parse(value ?? '[]');
    return Array.isArray(parsed)
      ? parsed.filter((s): s is string => typeof s === 'string')
      : [];
  } catch {
    return [];
  }
}

export function prismaStore(prisma: PrismaService): ApiKeyStore {
  return {
    async findByPrefix(prefix) {
      const row = await prisma.apiKey.findUnique({
        where: { prefix },
        include: { policy: true },
      });
      if (!row) return null;
      return {
        id: row.id,
        keyHash: row.keyHash,
        status: row.status,
        scopes: row.scopes,
        policyId: row.policyId,
        policy: row.policy
          ? {
              id: row.policy.id,
              windowSeconds: row.policy.windowSeconds,
              maxRequests: row.policy.maxRequests,
            }
          : null,
        expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
      };
    },
    async markUsed(id, at) {
      await prisma.apiKey.update({ where: { id }, data: { lastUsedAt: at } });
    },
  };
}
