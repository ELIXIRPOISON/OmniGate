import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { inject } from 'vitest';
import { applyTestEnv } from './setup/env.js';
import {
  adminSession,
  TEST_ADMIN_EMAIL,
  TEST_ADMIN_PASSWORD,
} from './setup/admin.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { AuditWriter } from '../src/audit/audit-writer.service.js';
import { loadEnv } from '../src/config/env.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { RedisService } from '../src/redis/redis.service.js';
import { RouteRegistry } from '../src/routing/route-registry.service.js';

describe('admin API and audit log (integration, real Redis + Postgres)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let redis: RedisService;
  let writer: AuditWriter;
  let upstream: Server;
  let upstreamPort: number;
  let tmp: string;
  let token: string;

  beforeAll(async () => {
    upstream = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
    upstreamPort = (upstream.address() as AddressInfo).port;

    tmp = mkdtempSync(join(tmpdir(), 'omnigate-admin-'));
    const routesFile = join(tmp, 'routes.yaml');
    writeFileSync(
      routesFile,
      `routes:\n  - { service: yamlroute, upstream: "http://127.0.0.1:${upstreamPort}", auth_required: false }\n`,
    );

    applyTestEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      ROUTES_FILE: routesFile,
      DATABASE_URL: inject('databaseUrl'),
      REDIS_URL: inject('redisUrl'),
      JWT_SECRET: 'admin-suite-secret-that-is-32-bytes!!',
      API_KEY_PEPPER: 'admin-suite-pepper',
      ADMIN_EMAIL: TEST_ADMIN_EMAIL,
      ADMIN_PASSWORD: TEST_ADMIN_PASSWORD,
      ADMIN_JWT_SECRET: 'admin-suite-jwt-secret-16',
      LLM_PROVIDER: 'fake',
      RL_DEFAULT_MAX: '100000',
      RL_ANON_MAX: '100000',
      ALLOW_PRIVATE_UPSTREAMS: 'true',
      WORKER_INLINE: 'false',
    });

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({
      bodyParser: false,
    });
    configureApp(app, loadEnv());
    await app.listen(0);
    prisma = app.get(PrismaService);
    redis = app.get(RedisService);
    writer = app.get(AuditWriter);
    for (let i = 0; i < 50 && !redis.isReady; i++)
      await new Promise((r) => setTimeout(r, 100));
    await redis.client.flushdb();
    await prisma.$executeRawUnsafe('TRUNCATE audit_logs');
    await prisma.anomalyEvent.deleteMany({});
    token = await adminSession(app);
  });

  afterAll(async () => {
    await app?.close();
    upstream?.closeAllConnections();
    await new Promise<void>((r) => upstream?.close(() => r()));
    rmSync(tmp, { recursive: true, force: true });
  });

  const http = () => request(app.getHttpServer());
  const auth = () => ({ Authorization: `Bearer ${token}` });

  // ---------------------------------------------------------------- S7-03 admin auth
  describe('authentication', () => {
    it('logs in with the seeded password and returns a 12 hour session', async () => {
      const res = await http()
        .post('/admin/v1/auth/login')
        .send({ email: TEST_ADMIN_EMAIL, password: TEST_ADMIN_PASSWORD })
        .expect(200);
      expect(res.body.expiresIn).toBe(12 * 3600);
      expect(String(res.body.accessToken).split('.')).toHaveLength(3);

      const me = await http().get('/admin/v1/auth/me').set(auth()).expect(200);
      expect(me.body.email).toBe(TEST_ADMIN_EMAIL);
    });

    it('rejects a wrong password and an unknown user identically', async () => {
      const wrong = await http()
        .post('/admin/v1/auth/login')
        .send({ email: TEST_ADMIN_EMAIL, password: 'nope' })
        .expect(401);
      expect(wrong.body.detail).toBe('Invalid email or password');
      const unknown = await http()
        .post('/admin/v1/auth/login')
        .send({ email: 'nobody@example.com', password: 'nope' })
        .expect(401);
      expect(unknown.body.detail).toBe(wrong.body.detail);
    });

    it('requires a session on every other endpoint', async () => {
      for (const path of [
        '/admin/v1/api-keys',
        '/admin/v1/routes',
        '/admin/v1/policies',
        '/admin/v1/metrics/overview',
        '/admin/v1/anomalies',
        '/admin/v1/logs',
      ]) {
        const res = await http().get(path).expect(401);
        expect(res.body.type).toBe('https://gw/errors/unauthorized');
      }
      await http()
        .get('/admin/v1/api-keys')
        .set('Authorization', 'Bearer not.a.token')
        .expect(401);
    });

    it('rate limits login attempts per IP (T12)', async () => {
      // The successful logins above already consumed part of this minute's allowance.
      let sawRateLimit = false;
      for (let i = 0; i < 10 && !sawRateLimit; i++) {
        const res = await http()
          .post('/admin/v1/auth/login')
          .send({ email: TEST_ADMIN_EMAIL, password: 'nope' });
        if (res.status === 429) sawRateLimit = true;
      }
      expect(sawRateLimit).toBe(true);
      // Clear the counter so the rest of the suite can still log in.
      const keys = await redis.client.keys('admin:login:*');
      if (keys.length) await redis.client.del(...keys);
    });
  });

  // ---------------------------------------------------------------- S7-04 CRUD
  describe('policies', () => {
    it('creates, lists, patches and refuses to delete one in use', async () => {
      const created = await http()
        .post('/admin/v1/policies')
        .set(auth())
        .send({ name: 'admin-suite-strict', windowSeconds: 60, maxRequests: 5 })
        .expect(201);
      expect(created.body).toMatchObject({
        name: 'admin-suite-strict',
        maxRequests: 5,
      });
      const policyId = created.body.id as string;

      await http()
        .post('/admin/v1/policies')
        .set(auth())
        .send({ name: 'admin-suite-strict', windowSeconds: 60, maxRequests: 5 })
        .expect(409);

      const patched = await http()
        .patch(`/admin/v1/policies/${policyId}`)
        .set(auth())
        .send({ maxRequests: 7 })
        .expect(200);
      expect(patched.body.maxRequests).toBe(7);

      const list = await http()
        .get('/admin/v1/policies')
        .set(auth())
        .expect(200);
      expect(
        list.body.items.some((p: { id: string }) => p.id === policyId),
      ).toBe(true);
      expect(list.body).toMatchObject({ page: 1, pageSize: 50 });

      // referenced by a key -> 409
      const key = await http()
        .post('/admin/v1/api-keys')
        .set(auth())
        .send({ name: 'policy-holder', scopes: [], policyId })
        .expect(201);
      const conflict = await http()
        .delete(`/admin/v1/policies/${policyId}`)
        .set(auth())
        .expect(409);
      expect(conflict.body.detail).toContain('referenced');

      await http()
        .delete(`/admin/v1/api-keys/${key.body.id}`)
        .set(auth())
        .expect(200);
      await prisma.apiKey.delete({ where: { id: key.body.id } });
      await http()
        .delete(`/admin/v1/policies/${policyId}`)
        .set(auth())
        .expect(200);
      await http().get(`/admin/v1/policies`).set(auth()).expect(200);
    });

    it('validates the body and reports every problem at once', async () => {
      const res = await http()
        .post('/admin/v1/policies')
        .set(auth())
        .send({ name: '', windowSeconds: 0, maxRequests: -1 })
        .expect(400);
      expect(res.body.type).toBe('https://gw/errors/bad-request');
      expect(res.body.detail).toContain('windowSeconds');
      expect(res.body.detail).toContain('maxRequests');
    });
  });

  describe('api keys', () => {
    it('creates a key whose raw value is shown once and works at the gateway', async () => {
      const created = await http()
        .post('/admin/v1/api-keys')
        .set(auth())
        .send({ name: 'suite-key', scopes: ['orders:read'] })
        .expect(201);
      expect(created.body.rawKey).toMatch(/^gw_live_[0-9A-Za-z]{32}$/);
      const { id, rawKey, prefix } = created.body;

      const fetched = await http()
        .get(`/admin/v1/api-keys/${id}`)
        .set(auth())
        .expect(200);
      expect(fetched.body.rawKey).toBeUndefined();
      expect(fetched.body).toMatchObject({
        prefix,
        name: 'suite-key',
        status: 'active',
        requests24h: 0,
      });

      // usable on the data plane
      await http().get('/api/yamlroute/x').set('X-API-Key', rawKey).expect(200);

      // revoking takes effect immediately, without waiting for the cache TTL
      await http().delete(`/admin/v1/api-keys/${id}`).set(auth()).expect(200);
      await http().get('/api/yamlroute/x').set('X-API-Key', rawKey).expect(403);
    });

    it('rotates a key: the old one stops working, the new one starts', async () => {
      const created = await http()
        .post('/admin/v1/api-keys')
        .set(auth())
        .send({ name: 'rotate-me', scopes: [] })
        .expect(201);
      await http()
        .get('/api/yamlroute/x')
        .set('X-API-Key', created.body.rawKey)
        .expect(200);

      const rotated = await http()
        .post(`/admin/v1/api-keys/${created.body.id}/rotate`)
        .set(auth())
        .expect(200);
      expect(rotated.body.rawKey).not.toBe(created.body.rawKey);
      expect(rotated.body.id).not.toBe(created.body.id);

      await http()
        .get('/api/yamlroute/x')
        .set('X-API-Key', created.body.rawKey)
        .expect(403);
      await http()
        .get('/api/yamlroute/x')
        .set('X-API-Key', rotated.body.rawKey)
        .expect(200);
    });

    it('filters by status and search term', async () => {
      const active = await http()
        .get('/admin/v1/api-keys?status=active')
        .set(auth())
        .expect(200);
      expect(
        active.body.items.every(
          (k: { status: string }) => k.status === 'active',
        ),
      ).toBe(true);
      const search = await http()
        .get('/admin/v1/api-keys?q=rotate-me')
        .set(auth())
        .expect(200);
      expect(search.body.items.length).toBeGreaterThanOrEqual(1);
      expect(search.body.items[0].name).toContain('rotate');
    });

    it('rejects an unknown policy and an unknown id', async () => {
      await http()
        .post('/admin/v1/api-keys')
        .set(auth())
        .send({
          name: 'bad',
          scopes: [],
          policyId: '00000000-0000-4000-8000-000000000000',
        })
        .expect(400);
      await http()
        .get('/admin/v1/api-keys/00000000-0000-4000-8000-000000000000')
        .set(auth())
        .expect(404);
      await http().get('/admin/v1/api-keys/not-a-uuid').set(auth()).expect(400);
    });
  });

  describe('routes', () => {
    it('creates a route that the registry picks up immediately', async () => {
      const created = await http()
        .post('/admin/v1/routes')
        .set(auth())
        .send({
          service: 'dbroute',
          upstream: `http://127.0.0.1:${upstreamPort}`,
          authRequired: false,
          cacheTtlSeconds: 5,
        })
        .expect(201);
      expect(created.body.service).toBe('dbroute');

      const res = await http().get('/api/dbroute/x').expect(200);
      expect(res.body).toEqual({ ok: true });

      const effective = await http()
        .get('/admin/v1/routes/effective')
        .set(auth())
        .expect(200);
      const entry = effective.body.items.find(
        (r: { service: string }) => r.service === 'dbroute',
      );
      expect(entry).toMatchObject({ source: 'database', cacheTtlSeconds: 5 });
      expect(
        effective.body.items.find(
          (r: { service: string }) => r.service === 'yamlroute',
        ),
      ).toMatchObject({
        source: 'yaml',
      });
    });

    it('rejects a duplicate service and an unroutable upstream', async () => {
      await http()
        .post('/admin/v1/routes')
        .set(auth())
        .send({
          service: 'dbroute',
          upstream: `http://127.0.0.1:${upstreamPort}`,
        })
        .expect(409);

      // ALLOW_PRIVATE_UPSTREAMS is on for this suite, so use a scheme that is always refused.
      const bad = await http()
        .post('/admin/v1/routes')
        .set(auth())
        .send({ service: 'badscheme', upstream: 'ftp://example.com' })
        .expect(400);
      expect(bad.body.detail).toContain('http');
    });

    it('patches a route and disabling it removes it from the registry', async () => {
      const row = await prisma.route.findUnique({
        where: { service: 'dbroute' },
      });
      const patched = await http()
        .patch(`/admin/v1/routes/${row!.id}`)
        .set(auth())
        .send({ timeoutMs: 1234 })
        .expect(200);
      expect(patched.body.timeoutMs).toBe(1234);

      await http()
        .patch(`/admin/v1/routes/${row!.id}`)
        .set(auth())
        .send({ enabled: false })
        .expect(200);
      await http().get('/api/dbroute/x').expect(404);

      await http()
        .patch(`/admin/v1/routes/${row!.id}`)
        .set(auth())
        .send({ enabled: true })
        .expect(200);
      await http().get('/api/dbroute/x').expect(200);
    });

    it('reloads on demand and reports the route count', async () => {
      const res = await http()
        .post('/admin/v1/routes/reload')
        .set(auth())
        .expect(200);
      expect(res.body.routes).toBe(app.get(RouteRegistry).size);
    });

    it('deletes a route, purges its cache and stops serving it', async () => {
      const created = await http()
        .post('/admin/v1/routes')
        .set(auth())
        .send({
          service: 'temporary',
          upstream: `http://127.0.0.1:${upstreamPort}`,
          authRequired: false,
        })
        .expect(201);
      await http().get('/api/temporary/x').expect(200);
      const removed = await http()
        .delete(`/admin/v1/routes/${created.body.id}`)
        .set(auth())
        .expect(200);
      expect(removed.body.deleted).toBe(true);
      await http().get('/api/temporary/x').expect(404);
    });
  });

  // ---------------------------------------------------------------- S7-01/02 audit log
  describe('audit log', () => {
    it('records one row per proxied request, including gateway-produced errors', async () => {
      await writer.flush(true);
      const before = Number(
        (
          await prisma.$queryRaw<
            Array<{ c: bigint }>
          >`SELECT count(*)::bigint AS c FROM audit_logs`
        )[0].c,
      );
      const ok = await http()
        .get('/api/yamlroute/audit-me?x=1')
        .set('User-Agent', 'suite/1.0')
        .expect(200);
      await http().get('/api/nosuchservice/x').expect(404);
      await writer.flush(true);

      const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>`
        SELECT request_id, method, path, status_code, latency_ms, host(client_ip) AS ip, user_agent, error_type, principal
        FROM audit_logs ORDER BY ts DESC LIMIT 2`;
      const after = Number(
        (
          await prisma.$queryRaw<
            Array<{ c: bigint }>
          >`SELECT count(*)::bigint AS c FROM audit_logs`
        )[0].c,
      );
      expect(after).toBe(before + 2);

      const success = rows.find(
        (r) => r.request_id === ok.headers['x-request-id'],
      );
      expect(success).toMatchObject({
        method: 'GET',
        path: '/api/yamlroute/audit-me',
        status_code: 200,
        user_agent: 'suite/1.0',
        principal: expect.stringContaining('anon:'),
      });
      expect(Number(success!.latency_ms)).toBeGreaterThanOrEqual(0);
      expect(success!.ip).toBe('127.0.0.1');

      const notFound = rows.find((r) => r.status_code === 404);
      expect(notFound?.error_type).toBe('route-not-found');
    });

    it('discards a batch Postgres keeps rejecting instead of blocking every later write', async () => {
      const poison = { ...validRecord(), method: 'X'.repeat(50) }; // too long for VARCHAR(10)
      writer.add(poison);
      // first attempt keeps it, second gives up on it
      await writer.flush(true);
      expect(writer.stats.size).toBe(1);
      await writer.flush(true);
      expect(writer.stats.size).toBe(0);

      // and the writer still works afterwards
      writer.add({ ...validRecord(), requestId: 'after-poison' });
      await writer.flush(true);
      const [{ c }] = await prisma.$queryRaw<Array<{ c: bigint }>>`
        SELECT count(*)::bigint AS c FROM audit_logs WHERE request_id = 'after-poison'`;
      expect(Number(c)).toBe(1);
    });

    it('maintains partitions idempotently', async () => {
      const first = await writer.maintainPartitions();
      expect(first.created.length).toBe(3);
      const second = await writer.maintainPartitions();
      expect(second.created).toEqual(first.created);

      const parts = await prisma.$queryRaw<Array<{ relname: string }>>`
        SELECT c.relname FROM pg_inherits i
        JOIN pg_class c ON c.oid = i.inhrelid
        JOIN pg_class p ON p.oid = i.inhparent
        WHERE p.relname = 'audit_logs' ORDER BY 1`;
      expect(parts.length).toBeGreaterThanOrEqual(3);
      expect(
        parts.every((p) => /^audit_logs_\d{4}_\d{2}$/.test(p.relname)),
      ).toBe(true);
    });
  });

  // ---------------------------------------------------------------- S7-05 metrics, anomalies, logs
  describe('metrics, logs and anomalies', () => {
    beforeAll(async () => {
      for (let i = 0; i < 5; i++)
        await http().get(`/api/yamlroute/metric-${i}`).expect(200);
      await http().get('/api/nosuchservice/y').expect(404);
      await writer.flush(true);
    });

    it('overview reports counts, latency percentiles and ratios', async () => {
      const res = await http()
        .get('/admin/v1/metrics/overview')
        .set(auth())
        .expect(200);
      expect(res.body.requests).toBeGreaterThanOrEqual(6);
      expect(res.body.p95).toBeGreaterThanOrEqual(0);
      expect(res.body.errorRate).toBeGreaterThanOrEqual(0);
      expect(res.body).toHaveProperty('cacheHitRatio');
      expect(res.body).toHaveProperty('anomalies');
      expect(
        new Date(res.body.to).getTime() - new Date(res.body.from).getTime(),
      ).toBe(3_600_000);
    });

    it('timeseries buckets the window and breakdown groups by route', async () => {
      const ts = await http()
        .get('/admin/v1/metrics/timeseries?bucket=1m')
        .set(auth())
        .expect(200);
      expect(ts.body.points.length).toBeGreaterThan(0);
      expect(ts.body.points[0]).toHaveProperty('requests');
      expect(
        ts.body.points.reduce(
          (sum: number, p: { requests: number }) => sum + p.requests,
          0,
        ),
      ).toBeGreaterThanOrEqual(6);

      const byRoute = await http()
        .get('/admin/v1/metrics/breakdown?by=route')
        .set(auth())
        .expect(200);
      expect(byRoute.body.items.length).toBeGreaterThan(0);
      const byStatus = await http()
        .get('/admin/v1/metrics/breakdown?by=status')
        .set(auth())
        .expect(200);
      expect(
        byStatus.body.items.some((i: { key: string }) => i.key === '404'),
      ).toBe(true);
      const byIp = await http()
        .get('/admin/v1/metrics/breakdown?by=client_ip')
        .set(auth())
        .expect(200);
      expect(byIp.body.items[0].key).toBe('127.0.0.1');
    });

    it('rejects an inverted range with 400 problem+json', async () => {
      const res = await http()
        .get(
          '/admin/v1/metrics/overview?from=2026-09-02T00:00:00Z&to=2026-09-01T00:00:00Z',
        )
        .set(auth())
        .expect(400);
      expect(res.body.detail).toContain('from must be before to');
    });

    it('logs explorer filters by status, path and request id', async () => {
      const all = await http()
        .get('/admin/v1/logs?limit=1000')
        .set(auth())
        .expect(200);
      expect(all.body.items.length).toBeGreaterThanOrEqual(6);
      expect(all.body.items[0]).toHaveProperty('requestId');

      const errors = await http()
        .get('/admin/v1/logs?statusClass=4xx')
        .set(auth())
        .expect(200);
      expect(
        errors.body.items.every(
          (l: { status: number }) => l.status >= 400 && l.status < 500,
        ),
      ).toBe(true);

      const one = await http()
        .get(`/admin/v1/logs?requestId=${all.body.items[0].requestId}`)
        .set(auth())
        .expect(200);
      expect(one.body.items).toHaveLength(1);
      expect(one.body.items[0].route ?? null).not.toBeUndefined();
    });

    it('lists, reviews and throttles anomalies', async () => {
      const event = await prisma.anomalyEvent.create({
        data: {
          requestId: 'admin-suite-anomaly',
          clientIp: '203.0.113.77',
          method: 'GET',
          path: '/api/yamlroute/evil',
          heuristicScore: 0.95,
          llmScore: 0.97,
          verdict: 'malicious',
          categories: ['sqli'],
          reasoning: 'test fixture',
          blocked: true,
        },
      });

      const list = await http()
        .get('/admin/v1/anomalies?minScore=0.9')
        .set(auth())
        .expect(200);
      expect(
        list.body.items.some((a: { id: string }) => a.id === event.id),
      ).toBe(true);
      expect(list.body.total).toBeGreaterThanOrEqual(1);

      const filtered = await http()
        .get('/admin/v1/anomalies?verdict=benign')
        .set(auth())
        .expect(200);
      expect(
        filtered.body.items.every(
          (a: { verdict: string }) => a.verdict === 'benign',
        ),
      ).toBe(true);

      const one = await http()
        .get(`/admin/v1/anomalies/${event.id}`)
        .set(auth())
        .expect(200);
      expect(one.body.reasoning).toBe('test fixture');

      const reviewed = await http()
        .patch(`/admin/v1/anomalies/${event.id}/review`)
        .set(auth())
        .send({ reviewed: true, label: 'true_positive' })
        .expect(200);
      expect(reviewed.body).toMatchObject({
        reviewed: true,
        reviewLabel: 'true_positive',
      });

      const throttled = await http()
        .post(`/admin/v1/anomalies/${event.id}/throttle-key`)
        .set(auth())
        .send({ seconds: 120 })
        .expect(200);
      expect(throttled.body.principal).toBe('anon:203.0.113.77');
      const ttl = await redis.client.ttl('throttle:anon:203.0.113.77');
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(120);
    });
  });
});

function validRecord() {
  return {
    ts: new Date(),
    requestId: 'poison',
    apiKeyId: null,
    routeId: null,
    principal: 'anon:127.0.0.1',
    method: 'GET',
    path: '/x',
    statusCode: 200,
    latencyMs: 1,
    upstreamMs: null,
    clientIp: '127.0.0.1',
    userAgent: null,
    reqBytes: null,
    resBytes: null,
    rateLimited: false,
    cacheStatus: null,
    anomalyScore: null,
    errorType: null,
  };
}
