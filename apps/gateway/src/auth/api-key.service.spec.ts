import type { PinoLogger } from 'nestjs-pino';
import type { Env } from '../config/env.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { RedisService } from '../redis/redis.service.js';
import { generateApiKey } from './api-key.js';
import {
  ApiKeyService,
  type CachedApiKey,
  fromHash,
  toHash,
} from './api-key.service.js';

const pepper = 'unit-test-pepper';
const env = { API_KEY_PEPPER: pepper } as Env;
const logger = {
  setContext() {},
  error() {},
  warn() {},
  info() {},
} as unknown as PinoLogger;

/** Redis stand-in: `absent` behaves like a down Redis (fallbacks only); otherwise a tiny hash store. */
function fakeRedis(absent = false) {
  const hashes = new Map<string, Record<string, string>>();
  const client = {
    hgetall: async (k: string) => hashes.get(k) ?? {},
    del: async (k: string) => (hashes.delete(k) ? 1 : 0),
    multi() {
      const ops: Array<() => void> = [];
      const chain = {
        del: (k: string) => (ops.push(() => hashes.delete(k)), chain),
        hset: (k: string, v: Record<string, string>) => (
          ops.push(() => hashes.set(k, { ...v })),
          chain
        ),
        expire: () => chain,
        exec: async () => ops.forEach((op) => op()),
      };
      return chain;
    },
  };
  const redis = {
    hashes,
    safe: async <T>(
      _w: string,
      fn: (c: typeof client) => Promise<T>,
      fallback: T,
    ) => (absent ? fallback : fn(client)),
  };
  return redis as unknown as RedisService & { hashes: typeof hashes };
}

function fakePrisma(rows: Array<{ prefix: string } & Record<string, unknown>>) {
  const findUnique = vi.fn(async ({ where }: { where: { prefix: string } }) => {
    const r = rows.find((x) => x.prefix === where.prefix);
    return r ? { policy: null, ...r } : null;
  });
  const update = vi.fn(async () => ({}));
  return {
    prisma: { apiKey: { findUnique, update } } as unknown as PrismaService,
    findUnique,
    update,
  };
}

/** Shaped like a Prisma ApiKey row (Date fields), which is what the store adapter consumes. */
function row(
  over: Partial<Omit<CachedApiKey, 'expiresAt'>> & {
    expiresAt?: Date | null;
    raw?: string;
  } = {},
) {
  const gen = generateApiKey(pepper);
  return {
    raw: gen.raw,
    id: 'k1',
    prefix: gen.prefix,
    keyHash: gen.keyHash,
    status: 'active',
    scopes: ['orders:read'],
    policyId: null,
    policy: null,
    expiresAt: null,
    ...over,
  };
}

describe('ApiKeyService', () => {
  it('authenticates a valid key and returns its scopes', async () => {
    const r = row();
    const { prisma } = fakePrisma([r]);
    const svc = new ApiKeyService(env, prisma, fakeRedis(true), logger);
    await expect(svc.authenticate(r.raw)).resolves.toEqual({
      principal: { type: 'api_key', id: 'k1', scopes: ['orders:read'] },
      policy: null,
    });
  });

  it('rejects malformed, unknown and wrong-secret keys as 401 reasons', async () => {
    const r = row();
    const svc = new ApiKeyService(
      env,
      fakePrisma([r]).prisma,
      fakeRedis(true),
      logger,
    );
    await expect(svc.authenticate('nope')).rejects.toMatchObject({
      reason: 'malformed',
    });
    await expect(
      svc.authenticate(generateApiKey(pepper).raw),
    ).rejects.toMatchObject({ reason: 'invalid' });
    const tampered = r.raw.slice(0, -1) + (r.raw.endsWith('a') ? 'b' : 'a');
    await expect(svc.authenticate(tampered)).rejects.toMatchObject({
      reason: 'invalid',
    });
  });

  it('distinguishes revoked and expired keys (403 reasons)', async () => {
    const revoked = row({ status: 'revoked' });
    const expired = row({
      expiresAt: new Date(Date.now() - 1000),
    });
    const svc = new ApiKeyService(
      env,
      fakePrisma([revoked, expired]).prisma,
      fakeRedis(true),
      logger,
    );
    await expect(svc.authenticate(revoked.raw)).rejects.toMatchObject({
      reason: 'revoked',
    });
    await expect(svc.authenticate(expired.raw)).rejects.toMatchObject({
      reason: 'key_expired',
    });
  });

  it('reports the store as unavailable when the database call fails', async () => {
    const prisma = {
      apiKey: {
        findUnique: async () => {
          throw new Error('ECONNREFUSED');
        },
      },
    } as unknown as PrismaService;
    const svc = new ApiKeyService(env, prisma, fakeRedis(true), logger);
    await expect(
      svc.authenticate(generateApiKey(pepper).raw),
    ).rejects.toMatchObject({ reason: 'unavailable' });
  });

  it('reads through Redis: one DB lookup, then cache hits, until invalidated', async () => {
    const r = row();
    const { prisma, findUnique } = fakePrisma([r]);
    const redis = fakeRedis();
    const svc = new ApiKeyService(env, prisma, redis, logger);
    await svc.authenticate(r.raw);
    await svc.authenticate(r.raw);
    expect(findUnique).toHaveBeenCalledTimes(1);
    expect(redis.hashes.get(`key:${r.prefix}`)?.id).toBe('k1');
    await svc.invalidate(r.prefix);
    await svc.authenticate(r.raw);
    expect(findUnique).toHaveBeenCalledTimes(2);
  });

  it('caches negative lookups so unknown prefixes do not hammer the database', async () => {
    const { prisma, findUnique } = fakePrisma([]);
    const svc = new ApiKeyService(env, prisma, fakeRedis(), logger);
    const unknown = generateApiKey(pepper).raw;
    await expect(svc.authenticate(unknown)).rejects.toMatchObject({
      reason: 'invalid',
    });
    await expect(svc.authenticate(unknown)).rejects.toMatchObject({
      reason: 'invalid',
    });
    expect(findUnique).toHaveBeenCalledTimes(1);
  });

  it('updates lastUsedAt at most once per minute per key', async () => {
    const r = row();
    const { prisma, update } = fakePrisma([r]);
    const svc = new ApiKeyService(env, prisma, fakeRedis(true), logger);
    await svc.authenticate(r.raw);
    await svc.authenticate(r.raw);
    await new Promise((resolve) => setImmediate(resolve));
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'k1' } }),
    );
  });

  it('round-trips records through the Redis hash format', () => {
    const rec: CachedApiKey = {
      id: 'i',
      keyHash: 'h',
      status: 'active',
      scopes: ['a', 'b'],
      policyId: 'p1',
      policy: { id: 'p1', windowSeconds: 60, maxRequests: 10 },
      expiresAt: null,
    };
    expect(fromHash(toHash(rec))).toEqual(rec);
    expect(
      fromHash({ id: 'i', keyHash: 'h', status: 'weird', scopes: 'not json' }),
    ).toMatchObject({ status: 'revoked', scopes: [] });
  });
});
