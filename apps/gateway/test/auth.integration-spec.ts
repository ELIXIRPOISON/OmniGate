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
import { applyTestEnv } from './setup/env.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { ApiKeyService } from '../src/auth/api-key.service.js';
import { loadEnv } from '../src/config/env.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { seed, type SeedResult } from '../src/prisma/seed.js';

const JWT_SECRET = 'integration-test-secret-32-bytes-long!';
const PEPPER = 'integration-pepper-16';

function echoUpstream(): Promise<{ server: Server; port: number }> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ url: req.url, headers: req.headers }));
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, port: (server.address() as AddressInfo).port }),
    ),
  );
}

const jwt = (claims: Record<string, unknown>, exp: string | number = '5m') =>
  new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(exp)
    .sign(new TextEncoder().encode(JWT_SECRET));

describe('auth + readiness (integration, real Redis + Postgres)', () => {
  let app: NestExpressApplication;
  let upstream: Server;
  let tmp: string;
  let seeded: SeedResult;
  let prisma: PrismaService;

  beforeAll(async () => {
    const up = await echoUpstream();
    upstream = up.server;
    tmp = mkdtempSync(join(tmpdir(), 'omnigate-int-'));
    const routesFile = join(tmp, 'routes.yaml');
    writeFileSync(
      routesFile,
      [
        'routes:',
        `  - { service: open, upstream: "http://127.0.0.1:${up.port}", auth_required: false }`,
        `  - { service: secure, upstream: "http://127.0.0.1:${up.port}" }`,
        `  - { service: orders, upstream: "http://127.0.0.1:${up.port}", scopes: [orders:read] }`,
        `  - { service: admin, upstream: "http://127.0.0.1:${up.port}", scopes: [admin:write] }`,
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
      TRUST_PROXY: 'false',
    });

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({
      bodyParser: false,
    });
    configureApp(app, loadEnv());
    await app.init();

    prisma = app.get(PrismaService);
    seeded = await seed(prisma, {
      adminEmail: 'admin@example.com',
      adminPassword: 'admin',
      pepper: PEPPER,
      mockUpstreamUrl: `http://127.0.0.1:${up.port}`,
    });
    // give the lazily-connecting Redis client a moment
    await new Promise((r) => setTimeout(r, 300));
  });

  afterAll(async () => {
    await app?.close();
    upstream?.closeAllConnections();
    await new Promise<void>((r) => upstream?.close(() => r()));
    rmSync(tmp, { recursive: true, force: true });
  });

  const http = () => request(app.getHttpServer());

  it('/readyz is 200 with redis and postgres ok and the route count', async () => {
    const res = await http().get('/readyz').expect(200);
    expect(res.body).toEqual({
      status: 'ok',
      redis: 'ok',
      postgres: 'ok',
      routes: 4,
    });
  });

  it('seed created the admin, three policies, two routes and a demo key', async () => {
    expect(await prisma.adminUser.count()).toBe(1);
    expect(
      await prisma.rateLimitPolicy.count({
        where: { name: { in: ['default', 'strict', 'generous'] } },
      }),
    ).toBe(3);
    expect(
      await prisma.route.count({
        where: { service: { in: ['mock', 'orders'] } },
      }),
    ).toBe(2);
    expect(seeded.demoKey.raw).toMatch(/^gw_live_[0-9A-Za-z]{32}$/);
    const stored = await prisma.apiKey.findUnique({
      where: { id: seeded.demoKey.id },
    });
    expect(stored?.keyHash).not.toContain(seeded.demoKey.raw.slice(8));
  });

  it('happy path: demo API key reaches the upstream with X-Gateway-Principal api_key:<id>', async () => {
    const res = await http()
      .get('/api/secure/x')
      .set('X-API-Key', seeded.demoKey.raw)
      .expect(200);
    expect(res.body.headers['x-gateway-principal']).toBe(
      `api_key:${seeded.demoKey.id}`,
    );
    expect(res.body.headers['x-api-key']).toBeUndefined();
  });

  it('happy path: HS256 JWT reaches the upstream with X-Gateway-Principal user:<sub>', async () => {
    const token = await jwt({ sub: 'alice', scope: 'orders:read' });
    const res = await http()
      .get('/api/orders/list')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body.headers['x-gateway-principal']).toBe('user:alice');
    expect(res.body.headers['authorization']).toBe(`Bearer ${token}`);
  });

  it('open route: anonymous principal is the client IP', async () => {
    const res = await http().get('/api/open/x').expect(200);
    expect(res.body.headers['x-gateway-principal']).toMatch(/^anon:/);
  });

  it('401: missing credentials, expired JWT, unknown key, malformed key', async () => {
    const missing = await http().get('/api/secure/x').expect(401);
    expect(missing.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(missing.headers['www-authenticate']).toContain('Bearer');
    expect(missing.body.type).toBe('https://gw/errors/unauthorized');

    const expired = await jwt(
      { sub: 'alice' },
      Math.floor(Date.now() / 1000) - 600,
    );
    expect(
      (
        await http()
          .get('/api/secure/x')
          .set('Authorization', `Bearer ${expired}`)
          .expect(401)
      ).body.detail,
    ).toBe('Token expired');

    await http()
      .get('/api/secure/x')
      .set('X-API-Key', 'gw_live_' + 'Q'.repeat(32))
      .expect(401);
    await http().get('/api/secure/x').set('X-API-Key', 'not-a-key').expect(401);
  });

  it('403: valid credentials but wrong scope', async () => {
    const res = await http()
      .get('/api/admin/x')
      .set('X-API-Key', seeded.demoKey.raw)
      .expect(403);
    expect(res.body).toMatchObject({
      type: 'https://gw/errors/forbidden',
      status: 403,
    });
    expect(res.headers['www-authenticate']).toContain('insufficient_scope');
    const token = await jwt({ sub: 'bob', scope: 'other' });
    await http()
      .get('/api/orders/x')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('403: revoked key, immediately after cache invalidation', async () => {
    await prisma.apiKey.update({
      where: { id: seeded.demoKey.id },
      data: { status: 'revoked' },
    });
    await app.get(ApiKeyService).invalidate(seeded.demoKey.prefix);
    const res = await http()
      .get('/api/secure/x')
      .set('X-API-Key', seeded.demoKey.raw)
      .expect(403);
    expect(res.body.detail).toContain('revoked');
    await prisma.apiKey.update({
      where: { id: seeded.demoKey.id },
      data: { status: 'active' },
    });
    await app.get(ApiKeyService).invalidate(seeded.demoKey.prefix);
  });

  it('403: expired key', async () => {
    await prisma.apiKey.update({
      where: { id: seeded.demoKey.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await app.get(ApiKeyService).invalidate(seeded.demoKey.prefix);
    const res = await http()
      .get('/api/secure/x')
      .set('X-API-Key', seeded.demoKey.raw)
      .expect(403);
    expect(res.body.detail).toContain('expired');
    await prisma.apiKey.update({
      where: { id: seeded.demoKey.id },
      data: { expiresAt: null },
    });
    await app.get(ApiKeyService).invalidate(seeded.demoKey.prefix);
  });

  it('records lastUsedAt after use (asynchronously, throttled)', async () => {
    await http()
      .get('/api/secure/x')
      .set('X-API-Key', seeded.demoKey.raw)
      .expect(200);
    let lastUsedAt: Date | null = null;
    for (let i = 0; i < 20 && !lastUsedAt; i++) {
      await new Promise((r) => setTimeout(r, 50));
      lastUsedAt =
        (await prisma.apiKey.findUnique({ where: { id: seeded.demoKey.id } }))
          ?.lastUsedAt ?? null;
    }
    expect(lastUsedAt).toBeInstanceOf(Date);
  });

  it('caches the key lookup in Redis under key:{prefix} with a TTL', async () => {
    await http()
      .get('/api/secure/x')
      .set('X-API-Key', seeded.demoKey.raw)
      .expect(200);
    const { RedisService } = await import('../src/redis/redis.service.js');
    const redis = app.get(RedisService);
    const hash = await redis.client.hgetall(`key:${seeded.demoKey.prefix}`);
    expect(hash.id).toBe(seeded.demoKey.id);
    const ttl = await redis.client.ttl(`key:${seeded.demoKey.prefix}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
  });

  it('still proxies 404/502 semantics with credentials present', async () => {
    await http()
      .get('/api/nope/x')
      .set('X-API-Key', seeded.demoKey.raw)
      .expect(404);
  });
});
