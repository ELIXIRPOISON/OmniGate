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
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { loadEnv } from '../src/config/env.js';

// ---- a tiny upstream that echoes what it receives ---------------------------------------------
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

const timers = new Set<NodeJS.Timeout>();

async function upstreamHandler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://upstream');
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  if (url.pathname === '/items' && req.method === 'GET') {
    return json(200, { items: [{ id: 1, name: 'Widget' }] });
  }
  if (url.pathname === '/items' && req.method === 'POST') {
    return json(201, { received: JSON.parse(await readBody(req)) });
  }
  if (url.pathname.includes('/echo')) {
    const body = await readBody(req);
    return json(200, {
      method: req.method,
      url: req.url,
      headers: req.headers,
      body,
    });
  }
  if (url.pathname === '/slow') {
    const ms = Number(url.searchParams.get('ms') ?? 1000);
    const t = setTimeout(() => {
      timers.delete(t);
      if (!res.destroyed) json(200, { slept_ms: ms });
    }, ms);
    timers.add(t);
    return;
  }
  if (url.pathname.startsWith('/status/')) {
    return json(Number(url.pathname.split('/')[2]), { from: 'upstream' });
  }
  if (url.pathname === '/chunked') {
    res.writeHead(200, {
      'content-type': 'text/plain',
      'transfer-encoding': 'chunked',
    });
    for (const chunk of ['chunk1', 'chunk2', 'chunk3']) {
      res.write(chunk);
      await new Promise((r) => setTimeout(r, 10));
    }
    res.end();
    return;
  }
  json(404, { error: 'not found' });
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve((server.address() as AddressInfo).port),
    ),
  );
}

async function freePort(): Promise<number> {
  const s = createServer();
  const port = await listen(s);
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

// ---- suite -------------------------------------------------------------------------------------
describe('proxy (e2e, no data stores)', () => {
  let app: NestExpressApplication;
  let upstream: Server;
  let tmp: string;

  beforeAll(async () => {
    upstream = createServer((req, res) => void upstreamHandler(req, res));
    const port = await listen(upstream);
    const deadPort = await freePort();

    tmp = mkdtempSync(join(tmpdir(), 'omnigate-e2e-'));
    const routesFile = join(tmp, 'routes.yaml');
    writeFileSync(
      routesFile,
      [
        'routes:',
        `  - { service: mock, upstream: "http://127.0.0.1:${port}", auth_required: false }`,
        `  - { service: keep, upstream: "http://127.0.0.1:${port}", strip_prefix: false, auth_required: false }`,
        `  - { service: slow, upstream: "http://127.0.0.1:${port}", timeout_ms: 300, auth_required: false }`,
        `  - { service: dead, upstream: "http://127.0.0.1:${deadPort}", auth_required: false }`,
        '',
      ].join('\n'),
    );

    Object.assign(process.env, {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      ROUTES_FILE: routesFile,
      // closed ports: this suite runs without data stores and asserts the degraded readiness path
      DATABASE_URL: `postgresql://u:p@127.0.0.1:${deadPort}/db`,
      REDIS_URL: `redis://127.0.0.1:${deadPort}`,
      JWT_SECRET: 'test-secret-that-is-at-least-32-bytes-long',
      API_KEY_PEPPER: 'test-pepper-16chars',
      ADMIN_EMAIL: 'admin@example.com',
      ADMIN_PASSWORD: 'admin',
      ADMIN_JWT_SECRET: 'admin-secret-16chars',
      LLM_PROVIDER: 'fake',
      MAX_BODY_BYTES: '1024',
      TRUST_PROXY: 'false',
      // No Redis or Postgres in this suite, so do not start queue workers or schedulers.
      WORKER_INLINE: 'false',
    });

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({
      bodyParser: false,
    });
    configureApp(app, loadEnv());
    await app.init();
  });

  afterAll(async () => {
    for (const t of timers) clearTimeout(t);
    await app?.close();
    upstream?.closeAllConnections();
    await new Promise<void>((r) => upstream?.close(() => r()));
    rmSync(tmp, { recursive: true, force: true });
  });

  const http = () => request(app.getHttpServer());
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  it('proxies a GET and stamps a generated X-Request-Id (sprint exit demo)', async () => {
    const res = await http().get('/api/mock/items').expect(200);
    expect(res.body).toEqual({ items: [{ id: 1, name: 'Widget' }] });
    expect(res.headers['x-request-id']).toMatch(UUID);
  });

  it('reuses a valid inbound X-Request-Id and forwards it upstream', async () => {
    const res = await http()
      .get('/api/mock/echo')
      .set('X-Request-Id', 'trace-42')
      .expect(200);
    expect(res.headers['x-request-id']).toBe('trace-42');
    expect(res.body.headers['x-request-id']).toBe('trace-42');
  });

  it('honours strip_prefix and preserves the query string', async () => {
    const stripped = await http().get('/api/mock/echo/a/b?x=1&y=2').expect(200);
    expect(stripped.body.url).toBe('/echo/a/b?x=1&y=2');
    const kept = await http().get('/api/keep/echo?x=1').expect(200);
    expect(kept.body.url).toBe('/api/keep/echo?x=1');
  });

  it('forwards JSON bodies on POST, PATCH and DELETE', async () => {
    const post = await http()
      .post('/api/mock/items')
      .send({ name: 'x' })
      .expect(201);
    expect(post.body).toEqual({ received: { name: 'x' } });
    const patch = await http()
      .patch('/api/mock/echo')
      .send({ op: 'patch' })
      .expect(200);
    expect(JSON.parse(patch.body.body)).toEqual({ op: 'patch' });
    const del = await http()
      .delete('/api/mock/echo')
      .send({ op: 'delete' })
      .expect(200);
    expect(JSON.parse(del.body.body)).toEqual({ op: 'delete' });
  });

  it('strips hop-by-hop and X-Gateway-* headers before the upstream', async () => {
    // Credential headers are covered by the integration suite: presenting them here would be
    // validated by the AuthGuard (and rejected, since no data stores are running).
    const res = await http()
      .get('/api/mock/echo')
      .set('X-Gateway-Principal', 'spoofed')
      .set('Connection', 'keep-alive, X-Custom-Hop')
      .set('X-Custom-Hop', '1')
      .set('TE', 'trailers')
      .set('X-Keep-Me', 'yes')
      .expect(200);
    const h = res.body.headers;
    expect(h['x-gateway-principal']).toMatch(/^anon:/);
    expect(h['x-custom-hop']).toBeUndefined();
    expect(h['te']).toBeUndefined();
    expect(h['keep-alive']).toBeUndefined();
    expect(h['x-keep-me']).toBe('yes');
  });

  it('adds X-Forwarded-* from the real connection and ignores spoofed values', async () => {
    const res = await http()
      .get('/api/mock/echo')
      .set('X-Forwarded-For', '1.2.3.4')
      .set('X-Forwarded-Proto', 'https')
      .expect(200);
    const h = res.body.headers;
    expect(h['x-forwarded-for']).toMatch(/127\.0\.0\.1$/);
    expect(h['x-forwarded-for']).not.toContain('1.2.3.4');
    expect(h['x-forwarded-proto']).toBe('http');
    expect(h['x-forwarded-host']).toBeDefined();
  });

  it('passes upstream status codes and bodies through untouched', async () => {
    const res = await http().get('/api/mock/status/503').expect(503);
    expect(res.body).toEqual({ from: 'upstream' });
    expect(res.headers['content-type']).toContain('application/json');
  });

  it('delivers chunked responses unchanged', async () => {
    const res = await http().get('/api/mock/chunked').expect(200);
    expect(res.text).toBe('chunk1chunk2chunk3');
  });

  it('returns 404 problem+json for an unknown service (sprint exit demo)', async () => {
    const res = await http().get('/api/nope/whatever').expect(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).toMatchObject({
      type: 'https://gw/errors/route-not-found',
      title: 'Not Found',
      status: 404,
      instance: '/api/nope/whatever',
    });
    expect(res.body.detail).toContain('nope');
    expect(res.body.requestId).toBe(res.headers['x-request-id']);
  });

  it('returns 404 problem+json when the service segment is missing', async () => {
    const res = await http().get('/api').expect(404);
    expect(res.body.type).toBe('https://gw/errors/route-not-found');
  });

  it('returns 502 problem+json when the upstream is down', async () => {
    const res = await http().get('/api/dead/items').expect(502);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).toMatchObject({
      type: 'https://gw/errors/bad-gateway',
      status: 502,
    });
    expect(res.body.detail).toContain('ECONNREFUSED');
  });

  it('returns 504 problem+json when the upstream exceeds the route timeout', async () => {
    const started = Date.now();
    const res = await http().get('/api/slow/slow?ms=3000').expect(504);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(res.body).toMatchObject({
      type: 'https://gw/errors/gateway-timeout',
      status: 504,
    });
  });

  it('rejects bodies whose Content-Length exceeds MAX_BODY_BYTES with 400', async () => {
    const res = await http()
      .post('/api/mock/items')
      .set('Content-Type', 'application/json')
      .send({ pad: 'x'.repeat(2048) })
      .expect(400);
    expect(res.body.type).toBe('https://gw/errors/bad-request');
  });

  it('serves /healthz with a request id', async () => {
    const res = await http().get('/healthz').expect(200);
    expect(res.body).toEqual({ status: 'ok' });
    expect(res.headers['x-request-id']).toMatch(UUID);
  });

  it('/readyz reports degraded with 503 when Redis and Postgres are unreachable', async () => {
    const res = await http().get('/readyz').expect(503);
    expect(res.body).toEqual({
      status: 'degraded',
      redis: 'error',
      postgres: 'error',
      routes: 4,
    });
  });

  it('answers 503 for an uncached API key while the credential store is down (never a silent allow)', async () => {
    const res = await http()
      .get('/api/mock/items')
      .set('X-API-Key', 'gw_live_' + 'a'.repeat(32));
    // credential store unreachable -> 503 rather than a silent allow (auth is never skipped)
    expect(res.status).toBe(503);
    expect(res.body.type).toBe('https://gw/errors/service-unavailable');
  });

  it('renders framework 404s as problem+json too', async () => {
    const res = await http().get('/definitely-not-a-route').expect(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body.type).toBe('https://gw/errors/not-found');
  });
});
