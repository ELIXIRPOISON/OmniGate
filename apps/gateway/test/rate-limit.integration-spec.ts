import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { SignJWT } from 'jose';
import request from 'supertest';
import { inject } from 'vitest';
import { applyTestEnv } from './setup/env.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { generateApiKey } from '../src/auth/api-key.js';
import { loadEnv } from '../src/config/env.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { RedisService } from '../src/redis/redis.service.js';

const JWT_SECRET = 'rate-limit-test-secret-32-bytes-long!!';
const PEPPER = 'rl-pepper-16chars';

const token = (sub: string) =>
  new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(new TextEncoder().encode(JWT_SECRET));

describe('rate limiting (integration, real Redis)', () => {
  let app: NestExpressApplication;
  let upstream: Server;
  let tmp: string;
  let redis: RedisService;
  let prisma: PrismaService;

  beforeAll(async () => {
    upstream = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
    const port = (upstream.address() as AddressInfo).port;

    tmp = mkdtempSync(join(tmpdir(), 'omnigate-rl-'));
    const routesFile = join(tmp, 'routes.yaml');
    writeFileSync(
      routesFile,
      [
        'routes:',
        `  - { service: hundred, upstream: "http://127.0.0.1:${port}", rate_limit: { window_seconds: 60, max_requests: 100 } }`,
        `  - { service: short, upstream: "http://127.0.0.1:${port}", rate_limit: { window_seconds: 2, max_requests: 2 } }`,
        `  - { service: tiny, upstream: "http://127.0.0.1:${port}", rate_limit: { window_seconds: 60, max_requests: 10 } }`,
        `  - { service: keyed, upstream: "http://127.0.0.1:${port}" }`,
        `  - { service: open, upstream: "http://127.0.0.1:${port}", auth_required: false }`,
        '',
      ].join('\n'),
    );

    applyTestEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      ROUTES_FILE: routesFile,
      DATABASE_URL: inject('databaseUrl'),
      REDIS_URL: inject('redisUrl'),
      JWT_SECRET,
      API_KEY_PEPPER: PEPPER,
      ADMIN_EMAIL: 'admin@example.com',
      ADMIN_PASSWORD: 'admin',
      ADMIN_JWT_SECRET: 'admin-secret-16chars',
      LLM_PROVIDER: 'fake',
      RL_DEFAULT_WINDOW_S: '60',
      RL_DEFAULT_MAX: '100',
      RL_ANON_MAX: '3',
      RL_FAIL_OPEN: 'true',
    });

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({
      bodyParser: false,
    });
    configureApp(app, loadEnv());
    // listen once: 50 truly concurrent requests below would otherwise race supertest's per-request listen/close
    await app.listen(0);
    redis = app.get(RedisService);
    prisma = app.get(PrismaService);
    for (let i = 0; i < 50 && !redis.isReady; i++)
      await new Promise((r) => setTimeout(r, 100));
    expect(redis.isReady).toBe(true);
    // other suites share this Redis and the anon principal is the same 127.0.0.1
    await redis.client.flushdb();
  });

  afterAll(async () => {
    await app?.close();
    upstream?.closeAllConnections();
    await new Promise<void>((r) => upstream?.close(() => r()));
    rmSync(tmp, { recursive: true, force: true });
  });

  const http = () => request(app.getHttpServer());
  const asUser = async (sub: string, path: string) =>
    http()
      .get(path)
      .set('Authorization', `Bearer ${await token(sub)}`);

  it('allows exactly max requests, then 429 with Retry-After >= 1 (docs/05 §1.4 case 1)', async () => {
    const t = await token('hundred-user');
    for (let i = 0; i < 100; i++) {
      const res = await http()
        .get('/api/hundred/x')
        .set('Authorization', `Bearer ${t}`);
      expect(res.status).toBe(200);
      expect(res.headers['x-ratelimit-limit']).toBe('100');
      expect(res.headers['x-ratelimit-remaining']).toBe(String(99 - i));
    }
    const denied = await http()
      .get('/api/hundred/x')
      .set('Authorization', `Bearer ${t}`)
      .expect(429);
    expect(denied.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(Number(denied.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(denied.headers['x-ratelimit-remaining']).toBe('0');
    expect(denied.body).toMatchObject({
      type: 'https://gw/errors/rate-limited',
      status: 429,
    });
    expect(denied.body.retryAfter).toBe(Number(denied.headers['retry-after']));
  });

  it('opens the window again after it elapses and reports a matching reset (case 2)', async () => {
    const before = Math.floor(Date.now() / 1000);
    expect((await asUser('short-user', '/api/short/x')).status).toBe(200);
    expect((await asUser('short-user', '/api/short/x')).status).toBe(200);
    const denied = await asUser('short-user', '/api/short/x');
    expect(denied.status).toBe(429);
    const reset = Number(denied.headers['x-ratelimit-reset']);
    expect(reset).toBeGreaterThanOrEqual(before + 1);
    expect(reset).toBeLessThanOrEqual(before + 4);
    await new Promise((r) => setTimeout(r, 2_200));
    expect((await asUser('short-user', '/api/short/x')).status).toBe(200);
  });

  it('is atomic under concurrency: 50 parallel requests at max=10 give exactly 10 x 200 (case 3)', async () => {
    const t = await token('tiny-user');
    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        http().get('/api/tiny/x').set('Authorization', `Bearer ${t}`),
      ),
    );
    const codes = results.map((r) => r.status);
    expect(codes.filter((c) => c === 200)).toHaveLength(10);
    expect(codes.filter((c) => c === 429)).toHaveLength(40);
    expect(codes.some((c) => c >= 500)).toBe(false);
  });

  it('resolves policy route -> key -> default and keys buckets per principal', async () => {
    const policy = await prisma.rateLimitPolicy.upsert({
      where: { name: 'rl-test-strict' },
      update: { windowSeconds: 60, maxRequests: 2 },
      create: { name: 'rl-test-strict', windowSeconds: 60, maxRequests: 2 },
    });
    const gen = generateApiKey(PEPPER);
    await prisma.apiKey.create({
      data: {
        name: 'rl-test',
        prefix: gen.prefix,
        keyHash: gen.keyHash,
        policyId: policy.id,
      },
    });

    // route without its own policy -> the key's policy (2/60)
    expect(
      (await http().get('/api/keyed/x').set('X-API-Key', gen.raw)).headers[
        'x-ratelimit-limit'
      ],
    ).toBe('2');
    await http().get('/api/keyed/x').set('X-API-Key', gen.raw).expect(200);
    await http().get('/api/keyed/x').set('X-API-Key', gen.raw).expect(429);
    // route with its own policy wins over the key's policy, with a separate bucket
    const viaRoute = await http()
      .get('/api/hundred/x')
      .set('X-API-Key', gen.raw)
      .expect(200);
    expect(viaRoute.headers['x-ratelimit-limit']).toBe('100');
  });

  it('caps anonymous traffic per IP with RL_ANON_MAX on open routes (S3-04)', async () => {
    for (let i = 0; i < 3; i++) {
      const res = await http().get('/api/open/x').expect(200);
      expect(res.headers['x-ratelimit-limit']).toBe('3');
      expect(res.headers['x-ratelimit-remaining']).toBe(String(2 - i));
    }
    const denied = await http().get('/api/open/x').expect(429);
    expect(denied.body.detail).toContain('Limit of 3 requests per 60s');
    expect(denied.body.detail).toContain('anon:');
  });

  it('honours a throttle:{principal} flag before the window is consulted', async () => {
    await redis.client.set('throttle:user:throttled-user', '1', 'EX', 30);
    const res = await asUser('throttled-user', '/api/hundred/x');
    expect(res.status).toBe(429);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect(Number(res.headers['retry-after'])).toBeLessThanOrEqual(30);
    expect(res.body.detail).toContain('throttled');
    expect(
      await redis.client.exists('rl:route:hundred:user:throttled-user'),
    ).toBe(0);
  });

  it('keeps entries in a TTL-bounded sorted set per bucket', async () => {
    await asUser('ttl-user', '/api/hundred/x');
    const key = 'rl:route:hundred:user:ttl-user';
    expect(await redis.client.type(key)).toBe('zset');
    const ttl = await redis.client.pttl(key);
    expect(ttl).toBeGreaterThan(55_000);
    expect(ttl).toBeLessThanOrEqual(61_000);
  });
});
