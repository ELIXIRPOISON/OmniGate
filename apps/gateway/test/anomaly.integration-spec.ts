import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
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
import { AnomalyQueue } from '../src/anomaly/queue/anomaly.queue.js';
import { AnomalyWorker } from '../src/anomaly/queue/anomaly.worker.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { loadEnv } from '../src/config/env.js';
import { RedisService } from '../src/redis/redis.service.js';

const JWT_SECRET = 'anomaly-test-secret-that-is-32-bytes-long';

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

const token = (sub: string) =>
  new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(new TextEncoder().encode(JWT_SECRET));

describe('anomaly pre-screen + queue (integration, real Redis)', () => {
  let app: NestExpressApplication;
  let upstream: Server;
  let tmp: string;
  let redis: RedisService;
  let queue: AnomalyQueue;
  const seen: Array<{
    method: string;
    url: string;
    headers: IncomingMessage['headers'];
    body: Buffer;
  }> = [];

  beforeAll(async () => {
    upstream = createServer(
      async (req: IncomingMessage, res: ServerResponse) => {
        const body = await readBody(req);
        seen.push({
          method: req.method ?? '',
          url: req.url ?? '',
          headers: req.headers,
          body,
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            echoedBytes: body.length,
            contentLength: req.headers['content-length'] ?? null,
          }),
        );
      },
    );
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
    const port = (upstream.address() as AddressInfo).port;

    tmp = mkdtempSync(join(tmpdir(), 'omnigate-anomaly-'));
    const routesFile = join(tmp, 'routes.yaml');
    writeFileSync(
      routesFile,
      [
        'routes:',
        `  - { service: open, upstream: "http://127.0.0.1:${port}", auth_required: false }`,
        `  - { service: strict, upstream: "http://127.0.0.1:${port}", auth_required: false, methods: [GET, POST] }`,
        `  - { service: quiet, upstream: "http://127.0.0.1:${port}", auth_required: false, anomaly_mode: off }`,
        `  - { service: syncr, upstream: "http://127.0.0.1:${port}", auth_required: false, anomaly_mode: sync }`,
        `  - { service: secure, upstream: "http://127.0.0.1:${port}" }`,
        '',
      ].join('\n'),
    );

    Object.assign(process.env, {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      ROUTES_FILE: routesFile,
      DATABASE_URL: inject('databaseUrl'),
      REDIS_URL: inject('redisUrl'),
      JWT_SECRET,
      API_KEY_PEPPER: 'anomaly-pepper-16c',
      ADMIN_EMAIL: 'admin@example.com',
      ADMIN_PASSWORD: 'admin',
      ADMIN_JWT_SECRET: 'admin-secret-16chars',
      LLM_PROVIDER: 'fake',
      RL_DEFAULT_MAX: '100000',
      RL_ANON_MAX: '100000',
      MAX_BODY_BYTES: '4096',
      EXPOSE_ANOMALY_SCORE: 'true',
      ANOMALY_SAMPLE_RATE: '0',
      ANOMALY_GATE_THRESHOLD: '0.4',
      WORKER_INLINE: 'true',
    });

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({
      bodyParser: false,
    });
    configureApp(app, loadEnv());
    await app.listen(0);
    redis = app.get(RedisService);
    queue = app.get(AnomalyQueue);
    for (let i = 0; i < 50 && !redis.isReady; i++)
      await new Promise((r) => setTimeout(r, 100));
    await redis.client.flushdb();
  });

  afterAll(async () => {
    await app?.close();
    upstream?.closeAllConnections();
    await new Promise<void>((r) => upstream?.close(() => r()));
    rmSync(tmp, { recursive: true, force: true });
  });

  const http = () => request(app.getHttpServer());

  it("scores an injection attempt high and a normal call near zero (sprint exit demo: ' OR 1=1)", async () => {
    const attack = await http()
      .get("/api/open/items?id=1' OR 1=1--")
      .set('User-Agent', 'Mozilla/5.0')
      .expect(200);
    expect(Number(attack.headers['x-anomaly-score'])).toBeGreaterThanOrEqual(
      0.9,
    );
    expect(attack.headers['x-anomaly-signals']).toContain(
      'injection_patterns=1.00',
    );
    const normal = await http()
      .get('/api/open/items?page=2')
      .set('User-Agent', 'Mozilla/5.0')
      .expect(200);
    expect(Number(normal.headers['x-anomaly-score'])).toBeLessThan(0.1);
  });

  it('queues the envelope for gated requests and the inline worker processes it (jobs visible in Redis)', async () => {
    expect(app.get(AnomalyWorker).running).toBe(true);
    const res = await http()
      .post('/api/open/search')
      .set('User-Agent', 'sqlmap/1.8')
      .send({ q: "x' UNION SELECT 1,2--", password: 'hunter2' })
      .expect(200);
    expect(res.headers['x-anomaly-queued']).toBe('gate');
    const keys = await redis.client.keys('bull:anomaly:*');
    expect(keys.length).toBeGreaterThan(0);
    let counts = await queue.counts();
    for (let i = 0; i < 40 && counts.completed < 1; i++) {
      await new Promise((r) => setTimeout(r, 50));
      counts = await queue.counts();
    }
    expect(counts.completed).toBeGreaterThanOrEqual(1);
    expect(counts.failed).toBe(0);
    // the stored job payload is the redacted envelope
    const jobId = res.headers['x-request-id'];
    const raw = await redis.client.hget(`bull:anomaly:${jobId}`, 'data');
    expect(raw).toBeTruthy();
    const data = JSON.parse(raw!);
    expect(data.envelope.bodySample).toContain('[REDACTED]');
    expect(data.envelope.bodySample).not.toContain('hunter2');
    expect(data.envelope.heuristics.categories).toEqual(
      expect.arrayContaining(['sqli', 'enumeration']),
    );
    expect(data.envelope.principalStats10m.requests).toBeGreaterThanOrEqual(1);
  });

  it('does not queue quiet traffic (sample rate 0) and skips scoring entirely when anomaly_mode is off', async () => {
    const calm = await http()
      .get('/api/open/items')
      .set('User-Agent', 'Mozilla/5.0')
      .expect(200);
    expect(calm.headers['x-anomaly-queued']).toBeUndefined();
    const off = await http().get("/api/quiet/items?id=1' OR 1=1--").expect(200);
    expect(off.headers['x-anomaly-score']).toBeUndefined();
  });

  it('sync routes are queued with reason=sync until Sprint 6 adds the awaited verdict', async () => {
    const res = await http()
      .get('/api/syncr/items')
      .set('User-Agent', 'Mozilla/5.0')
      .expect(200);
    expect(res.headers['x-anomaly-queued']).toBe('sync');
  });

  it('replays buffered bodies to the upstream byte-for-byte (JSON, form, binary, chunked)', async () => {
    seen.length = 0;
    const json = { name: 'Sprocket', nested: { note: 'ünïcødé ✓' } };
    const r1 = await http()
      .post('/api/open/items')
      .set('Content-Type', 'application/json')
      .send(json)
      .expect(200);
    expect(JSON.parse(seen[0].body.toString('utf8'))).toEqual(json);
    expect(r1.body.echoedBytes).toBe(Buffer.byteLength(JSON.stringify(json)));
    expect(seen[0].headers['content-length']).toBe(
      String(Buffer.byteLength(JSON.stringify(json))),
    );

    await http()
      .post('/api/open/form')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('a=1&b=two%20words')
      .expect(200);
    expect(seen[1].body.toString()).toBe('a=1&b=two%20words');

    const bin = Buffer.from(Array.from({ length: 1500 }, (_, i) => i % 256));
    await http()
      .put('/api/open/blob')
      .set('Content-Type', 'application/octet-stream')
      .send(bin)
      .expect(200);
    expect(Buffer.compare(seen[2].body, bin)).toBe(0);

    // chunked upload (no Content-Length; supertest cannot send one, Node rejects CL+TE together): buffered, replayed with an explicit length
    const port = (app.getHttpServer().address() as AddressInfo).port;
    const chunked = await new Promise<{ status: number; body: string }>(
      (resolve, reject) => {
        const req = httpRequest(
          {
            host: '127.0.0.1',
            port,
            method: 'POST',
            path: '/api/open/chunked',
            headers: { 'content-type': 'text/plain' },
          },
          (res) => {
            let body = '';
            res.on('data', (c: Buffer) => (body += c.toString()));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
          },
        );
        req.on('error', reject);
        req.write('hello ');
        setTimeout(() => req.end('chunked world'), 20);
      },
    );
    expect(chunked.status).toBe(200);
    expect(seen[3].body.toString()).toBe('hello chunked world');
    expect(seen[3].headers['content-length']).toBe('19');
    expect(seen[3].headers['transfer-encoding']).toBeUndefined();
    expect(JSON.parse(chunked.body).echoedBytes).toBe(19);
  });

  it('rejects bodies above MAX_BODY_BYTES with 400 without forwarding them', async () => {
    seen.length = 0;
    const res = await http()
      .post('/api/open/items')
      .set('Content-Type', 'application/json')
      .send({ pad: 'x'.repeat(5000) })
      .expect(400);
    expect(res.body.type).toBe('https://gw/errors/bad-request');
    expect(seen).toHaveLength(0);
  });

  it('flags method mismatch and scanner user agents', async () => {
    const mm = await http()
      .delete('/api/strict/items/1')
      .set('User-Agent', 'Mozilla/5.0')
      .expect(200);
    expect(mm.headers['x-anomaly-signals']).toContain('method_mismatch=1.00');
    const ua = await http()
      .get('/api/open/items')
      .set('User-Agent', 'Nikto/2.5')
      .expect(200);
    expect(ua.headers['x-anomaly-signals']).toContain('ua_anomaly=1.00');
    expect(Number(ua.headers['x-anomaly-score'])).toBeGreaterThanOrEqual(0.5);
    const missing = await http()
      .get('/api/open/items')
      .unset('User-Agent')
      .expect(200);
    expect(missing.headers['x-anomaly-signals']).toContain('ua_anomaly=0.60');
  });

  it('raises path_enum as one principal walks many distinct paths', async () => {
    const t = await token('walker');
    let last = '';
    for (let i = 0; i < 60; i++) {
      const r = await http()
        .get(`/api/secure/items/${i}`)
        .set('Authorization', `Bearer ${t}`)
        .set('User-Agent', 'Mozilla/5.0')
        .expect(200);
      last = r.headers['x-anomaly-signals'] ?? '';
    }
    expect(last).toMatch(/path_enum=(0\.[5-9]\d|1\.00)/);
  });

  it('counts rejected credentials per IP into auth_failures', async () => {
    for (let i = 0; i < 12; i++) {
      await http()
        .get('/api/secure/items')
        .set('Authorization', 'Bearer not.a.token')
        .expect(401);
    }
    const res = await http()
      .get('/api/open/items')
      .set('User-Agent', 'Mozilla/5.0')
      .expect(200);
    expect(res.headers['x-anomaly-signals']).toContain('auth_failures=1.00');
    expect(Number(res.headers['x-anomaly-score'])).toBeGreaterThanOrEqual(0.7);
  });
});
