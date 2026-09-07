import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { SignJWT } from 'jose';
import request from 'supertest';
import { inject } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { loadEnv } from '../src/config/env.js';
import { RedisService } from '../src/redis/redis.service.js';

const JWT_SECRET = 'cache-test-secret-that-is-32-bytes-long!';
const ADMIN_TOKEN = 'cache-test-admin-token-16+';

/** Upstream that counts calls per path and shapes its answer from query flags. */
function countingUpstream() {
  const calls = new Map<string, number>();
  const server: Server = createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', 'http://u');
      calls.set(url.pathname, (calls.get(url.pathname) ?? 0) + 1);
      const delay = Number(url.searchParams.get('delay') ?? 0);
      if (delay) await new Promise((r) => setTimeout(r, delay));
      const status = Number(url.searchParams.get('status') ?? 200);
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        etag: `"v${calls.get(url.pathname)}"`,
      };
      if (url.searchParams.get('cc'))
        headers['cache-control'] = url.searchParams.get('cc')!;
      if (url.searchParams.get('cookie')) headers['set-cookie'] = 'sid=1';
      const size = Number(url.searchParams.get('size') ?? 0);
      const body = size
        ? JSON.stringify({ pad: 'x'.repeat(size) })
        : JSON.stringify({
            path: url.pathname,
            n: calls.get(url.pathname),
            method: req.method,
          });
      res.writeHead(status, headers);
      res.end(req.method === 'HEAD' ? undefined : body);
    },
  );
  return { server, calls, count: (p: string) => calls.get(p) ?? 0 };
}

const token = (sub: string) =>
  new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(new TextEncoder().encode(JWT_SECRET));

async function bootApp(routesFile: string, extraEnv: Record<string, string>) {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    ROUTES_FILE: routesFile,
    DATABASE_URL: inject('databaseUrl'),
    REDIS_URL: inject('redisUrl'),
    JWT_SECRET,
    API_KEY_PEPPER: 'cache-pepper-16ch',
    ADMIN_EMAIL: 'admin@example.com',
    ADMIN_PASSWORD: 'admin',
    ADMIN_JWT_SECRET: 'admin-secret-16chars',
    ADMIN_TOKEN,
    LLM_PROVIDER: 'fake',
    RL_DEFAULT_MAX: '100000',
    RL_ANON_MAX: '100000',
    CACHE_MAX_BODY_BYTES: '4096',
    RL_COUNT_CACHE_HITS: 'true',
    ...extraEnv,
  });
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({
    bodyParser: false,
  });
  configureApp(app, loadEnv());
  await app.listen(0);
  const redis = app.get(RedisService);
  for (let i = 0; i < 50 && !redis.isReady; i++)
    await new Promise((r) => setTimeout(r, 100));
  await redis.client.flushdb();
  return { app, redis };
}

describe('response cache (integration, real Redis)', () => {
  let app: NestExpressApplication;
  let redis: RedisService;
  let tmp: string;
  const up = countingUpstream();

  beforeAll(async () => {
    await new Promise<void>((r) => up.server.listen(0, '127.0.0.1', () => r()));
    const port = (up.server.address() as AddressInfo).port;
    tmp = mkdtempSync(join(tmpdir(), 'omnigate-cache-'));
    const routesFile = join(tmp, 'routes.yaml');
    writeFileSync(
      routesFile,
      [
        'routes:',
        `  - { service: pub, upstream: "http://127.0.0.1:${port}", auth_required: false, cache_ttl_seconds: 30 }`,
        `  - { service: vary, upstream: "http://127.0.0.1:${port}", cache_ttl_seconds: 30 }`,
        `  - { service: shared, upstream: "http://127.0.0.1:${port}", cache_ttl_seconds: 30, cache_vary_on_principal: false }`,
        `  - { service: nocache, upstream: "http://127.0.0.1:${port}", auth_required: false }`,
        '',
      ].join('\n'),
    );
    ({ app, redis } = await bootApp(routesFile, {}));
  });

  afterAll(async () => {
    await app?.close();
    up.server.closeAllConnections();
    await new Promise<void>((r) => up.server.close(() => r()));
    rmSync(tmp, { recursive: true, force: true });
  });

  const http = () => request(app.getHttpServer());

  it('MISS then HIT within the TTL, one upstream call, Age increases (docs/09 cache table)', async () => {
    const first = await http().get('/api/pub/items').expect(200);
    expect(first.headers['x-cache']).toBe('MISS');
    expect(first.headers['age']).toBeUndefined();
    await new Promise((r) => setTimeout(r, 1_100));
    const second = await http().get('/api/pub/items').expect(200);
    expect(second.headers['x-cache']).toBe('HIT');
    expect(Number(second.headers['age'])).toBeGreaterThanOrEqual(1);
    expect(second.body).toEqual(first.body);
    expect(second.headers['content-type']).toContain('application/json');
    expect(second.headers['etag']).toBe(first.headers['etag']);
    expect(second.headers['x-request-id']).not.toBe(
      first.headers['x-request-id'],
    );
    expect(up.count('/items')).toBe(1);
  });

  it('normalises query order into one entry', async () => {
    await http().get('/api/pub/q?b=2&a=1').expect(200);
    const res = await http().get('/api/pub/q?a=1&b=2').expect(200);
    expect(res.headers['x-cache']).toBe('HIT');
    expect(up.count('/q')).toBe(1);
  });

  it('never caches POST and has no X-Cache header on non-cacheable routes', async () => {
    const post = await http().post('/api/pub/items').expect(200);
    expect(post.headers['x-cache']).toBeUndefined();
    const plain = await http().get('/api/nocache/items').expect(200);
    expect(plain.headers['x-cache']).toBeUndefined();
  });

  it('does not store upstream responses marked private / no-store, with Set-Cookie, or non-storable statuses', async () => {
    for (const path of [
      '/priv?cc=private',
      '/nostore?cc=no-store',
      '/cookie?cookie=1',
      '/err?status=500',
      '/created?status=201',
    ]) {
      await http().get(`/api/pub${path}`);
      const again = await http().get(`/api/pub${path}`);
      expect(again.headers['x-cache']).toBe('MISS');
    }
    expect(up.count('/priv')).toBe(2);
    expect(up.count('/err')).toBe(2);
  });

  it('caches 404 and 204 like the spec says', async () => {
    await http().get('/api/pub/missing?status=404').expect(404);
    expect(
      (await http().get('/api/pub/missing?status=404').expect(404)).headers[
        'x-cache'
      ],
    ).toBe('HIT');
    await http().get('/api/pub/empty?status=204').expect(204);
    const hit = await http().get('/api/pub/empty?status=204').expect(204);
    expect(hit.headers['x-cache']).toBe('HIT');
    expect(hit.text ?? '').toBe('');
  });

  it('skips bodies above CACHE_MAX_BODY_BYTES but still streams them', async () => {
    const big = await http().get('/api/pub/big?size=5000').expect(200);
    expect(big.body.pad).toHaveLength(5000);
    expect(
      (await http().get('/api/pub/big?size=5000')).headers['x-cache'],
    ).toBe('MISS');
    expect(up.count('/big')).toBe(2);
  });

  it('varies on principal by default and shares when the route opts out', async () => {
    const alice = await token('alice');
    const bob = await token('bob');
    await http()
      .get('/api/vary/me')
      .set('Authorization', `Bearer ${alice}`)
      .expect(200);
    const bobRes = await http()
      .get('/api/vary/me')
      .set('Authorization', `Bearer ${bob}`)
      .expect(200);
    expect(bobRes.headers['x-cache']).toBe('MISS');
    expect(up.count('/me')).toBe(2);

    await http()
      .get('/api/shared/catalog')
      .set('Authorization', `Bearer ${alice}`)
      .expect(200);
    const bobShared = await http()
      .get('/api/shared/catalog')
      .set('Authorization', `Bearer ${bob}`)
      .expect(200);
    expect(bobShared.headers['x-cache']).toBe('HIT');
    expect(up.count('/catalog')).toBe(1);
  });

  it('Cache-Control: no-cache bypasses the lookup and refreshes the entry; no-store skips the cache', async () => {
    await http().get('/api/pub/refresh').expect(200);
    const bypass = await http()
      .get('/api/pub/refresh')
      .set('Cache-Control', 'no-cache')
      .expect(200);
    expect(bypass.headers['x-cache']).toBe('BYPASS');
    expect(bypass.body.n).toBe(2);
    const hit = await http().get('/api/pub/refresh').expect(200);
    expect(hit.headers['x-cache']).toBe('HIT');
    expect(hit.body.n).toBe(2);
    const skip = await http()
      .get('/api/pub/refresh')
      .set('Cache-Control', 'no-store')
      .expect(200);
    expect(skip.headers['x-cache']).toBeUndefined();
    expect(up.count('/refresh')).toBe(3);
  });

  it('stampede lock: 50 concurrent misses on one key reach the upstream at most 3 times', async () => {
    const results = await Promise.all(
      Array.from({ length: 50 }, () => http().get('/api/pub/hot?delay=100')),
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    const statuses = results.map((r) => r.headers['x-cache']);
    expect(statuses.filter((s) => s === 'HIT').length).toBeGreaterThan(40);
    expect(up.count('/hot')).toBeLessThanOrEqual(3);
  });

  it('purge removes every entry of a route and empties the index; needs the admin token', async () => {
    await http().get('/api/pub/p1').expect(200);
    await http().get('/api/pub/p2').expect(200);
    expect(await redis.client.scard('cache:idx:pub')).toBeGreaterThanOrEqual(2);

    await http().post('/admin/v1/routes/pub/cache/purge').expect(401);
    await http()
      .post('/admin/v1/routes/pub/cache/purge')
      .set('Authorization', 'Bearer wrong-token-wrong-token')
      .expect(401);
    const purged = await http()
      .post('/admin/v1/routes/pub/cache/purge')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .expect(200);
    expect(purged.body.routeId).toBe('pub');
    expect(purged.body.deletedKeys).toBeGreaterThanOrEqual(2);
    expect(await redis.client.exists('cache:idx:pub')).toBe(0);
    expect(
      (await http().get('/api/pub/p1').expect(200)).headers['x-cache'],
    ).toBe('MISS');
    await http()
      .post('/admin/v1/routes/nope/cache/purge')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .expect(404);
  });

  it('keeps entries under cache:{route}:{sha1} with the route TTL', async () => {
    await http().get('/api/pub/ttl').expect(200);
    const keys = await redis.client.keys('cache:pub:*');
    expect(keys.length).toBeGreaterThan(0);
    const ttl = await redis.client.ttl(keys[0]);
    expect(ttl).toBeGreaterThan(25);
    expect(ttl).toBeLessThanOrEqual(30);
  });
});

describe('RL_COUNT_CACHE_HITS=false (integration)', () => {
  let app: NestExpressApplication;
  let tmp: string;
  const up = countingUpstream();

  beforeAll(async () => {
    await new Promise<void>((r) => up.server.listen(0, '127.0.0.1', () => r()));
    const port = (up.server.address() as AddressInfo).port;
    tmp = mkdtempSync(join(tmpdir(), 'omnigate-cache2-'));
    const routesFile = join(tmp, 'routes.yaml');
    writeFileSync(
      routesFile,
      `routes:\n  - { service: pub, upstream: "http://127.0.0.1:${port}", auth_required: false, cache_ttl_seconds: 30, rate_limit: { window_seconds: 60, max_requests: 3 } }\n`,
    );
    ({ app } = await bootApp(routesFile, { RL_COUNT_CACHE_HITS: 'false' }));
  });

  afterAll(async () => {
    await app?.close();
    up.server.closeAllConnections();
    await new Promise<void>((r) => up.server.close(() => r()));
    rmSync(tmp, { recursive: true, force: true });
  });

  it('cache hits do not consume the rate limit', async () => {
    const http = () => request(app.getHttpServer());
    const miss = await http().get('/api/pub/free').expect(200);
    expect(miss.headers['x-cache']).toBe('MISS');
    expect(miss.headers['x-ratelimit-remaining']).toBe('2');
    for (let i = 0; i < 10; i++) {
      const hit = await http().get('/api/pub/free').expect(200);
      expect(hit.headers['x-cache']).toBe('HIT');
      expect(hit.headers['x-ratelimit-remaining']).toBe('2');
    }
    // a different, uncached path still counts
    const other = await http().get('/api/pub/other').expect(200);
    expect(other.headers['x-ratelimit-remaining']).toBe('1');
  });
});
