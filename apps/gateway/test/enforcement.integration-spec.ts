import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { inject } from 'vitest';
import { LLM_PROVIDER_TOKEN } from '../src/anomaly/llm/llm.factory.js';
import {
  LlmError,
  type LlmProvider,
  type Verdict,
} from '../src/anomaly/llm/provider.js';
import { AnomalyQueue } from '../src/anomaly/queue/anomaly.queue.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { loadEnv } from '../src/config/env.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { RedisService } from '../src/redis/redis.service.js';

const MALICIOUS: Verdict = {
  score: 0.97,
  verdict: 'malicious',
  categories: ['sqli'],
  reasoning: 'SQL tautology payload from a scanner user agent.',
};
const BENIGN: Verdict = {
  score: 0.05,
  verdict: 'benign',
  categories: [],
  reasoning: 'Ordinary read.',
};

/** Provider whose behaviour each test sets, so enforcement can be exercised without a model. */
const script: { mode: 'malicious' | 'benign' | 'timeout'; calls: number } = {
  mode: 'benign',
  calls: 0,
};

const scriptedProvider: LlmProvider = {
  name: 'scripted',
  model: 'scripted-test-model',
  classify: async () => {
    script.calls++;
    if (script.mode === 'timeout')
      throw new LlmError('timeout', 'exceeded budget');
    return script.mode === 'malicious' ? MALICIOUS : BENIGN;
  },
};

const SQLI = "?id=1' OR 1=1--";

async function bootApp(routesFile: string, extra: Record<string, string>) {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    ROUTES_FILE: routesFile,
    DATABASE_URL: inject('databaseUrl'),
    REDIS_URL: inject('redisUrl'),
    JWT_SECRET: 'enforcement-test-secret-32-bytes-long',
    API_KEY_PEPPER: 'enforce-pepper-16c',
    ADMIN_EMAIL: 'admin@example.com',
    ADMIN_PASSWORD: 'admin',
    ADMIN_JWT_SECRET: 'admin-secret-16chars',
    LLM_PROVIDER: 'fake',
    RL_DEFAULT_MAX: '100000',
    RL_ANON_MAX: '100000',
    EXPOSE_ANOMALY_SCORE: 'true',
    ANOMALY_SAMPLE_RATE: '0',
    ANOMALY_GATE_THRESHOLD: '0.4',
    ANOMALY_BLOCK_THRESHOLD: '0.9',
    ANOMALY_AUTO_THROTTLE: 'false',
    WORKER_INLINE: 'true',
    ...extra,
  });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(LLM_PROVIDER_TOKEN)
    .useValue(scriptedProvider)
    .compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({
    bodyParser: false,
  });
  configureApp(app, loadEnv());
  await app.listen(0);
  const redis = app.get(RedisService);
  for (let i = 0; i < 50 && !redis.isReady; i++)
    await new Promise((r) => setTimeout(r, 100));
  await redis.client.flushdb();
  return { app, redis, prisma: app.get(PrismaService) };
}

function upstream(): Promise<{ server: Server; port: number }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, port: (server.address() as AddressInfo).port }),
    ),
  );
}

async function eventFor(prisma: PrismaService, requestId: string, tries = 40) {
  for (let i = 0; i < tries; i++) {
    const row = await prisma.anomalyEvent.findFirst({ where: { requestId } });
    if (row) return row;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

describe('anomaly enforcement (integration, real Redis + Postgres)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let server: Server;
  let tmp: string;

  beforeAll(async () => {
    const up = await upstream();
    server = up.server;
    tmp = mkdtempSync(join(tmpdir(), 'omnigate-enforce-'));
    const routesFile = join(tmp, 'routes.yaml');
    writeFileSync(
      routesFile,
      [
        'routes:',
        `  - { service: syncr, upstream: "http://127.0.0.1:${up.port}", auth_required: false, anomaly_mode: sync }`,
        `  - { service: asyncr, upstream: "http://127.0.0.1:${up.port}", auth_required: false, anomaly_mode: async }`,
        `  - { service: fast, upstream: "http://127.0.0.1:${up.port}", auth_required: false, anomaly_mode: sync, block_on_heuristic: true }`,
        '',
      ].join('\n'),
    );
    ({ app, prisma } = await bootApp(routesFile, {}));
  });

  afterAll(async () => {
    await app?.close();
    server?.closeAllConnections();
    await new Promise<void>((r) => server?.close(() => r()));
    rmSync(tmp, { recursive: true, force: true });
  });

  beforeEach(() => {
    script.mode = 'benign';
    script.calls = 0;
  });

  const http = () => request(app.getHttpServer());

  it('sync route: a verdict at or above the block threshold answers 403 problem+json (M3 demo)', async () => {
    script.mode = 'malicious';
    const res = await http()
      .get(`/api/syncr/orders${SQLI}`)
      .set('User-Agent', 'sqlmap/1.8')
      .expect(403);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).toMatchObject({
      type: 'https://gw/errors/forbidden',
      status: 403,
      detail: 'Request blocked by anomaly policy',
    });
    expect(res.headers['x-anomaly-blocked']).toBe('llm');
    expect(script.calls).toBe(1);

    const event = await eventFor(prisma, res.body.requestId);
    expect(event).toMatchObject({
      blocked: true,
      verdict: 'malicious',
      llmScore: MALICIOUS.score,
      model: 'scripted-test-model',
      reasoning: MALICIOUS.reasoning,
      method: 'GET',
      path: '/api/syncr/orders',
    });
    expect(event?.categories).toContain('sqli');
    expect(event?.heuristicScore).toBeGreaterThan(0.9);
    // the stored sample is redacted, never the raw request
    expect(event?.payloadSample).toContain('id=');
  });

  it('sync route: a benign verdict passes through and still records the event', async () => {
    const res = await http()
      .get('/api/syncr/orders?page=2')
      .set('User-Agent', 'Mozilla/5.0')
      .expect(200);
    expect(res.headers['x-anomaly-queued']).toBe('sync');
    expect(res.headers['x-anomaly-llm-score']).toBe('0.050');
    const event = await eventFor(prisma, res.headers['x-request-id']);
    expect(event).toMatchObject({
      blocked: false,
      verdict: 'benign',
      llmScore: BENIGN.score,
    });
  });

  it('sync route: a model timeout fails open, records the event and keeps the heuristic score', async () => {
    script.mode = 'timeout';
    // A distinct path, so the earlier malicious verdict is not reused from the dedup cache.
    const res = await http()
      .get(`/api/syncr/timeout${SQLI}`)
      .set('User-Agent', 'sqlmap/1.8')
      .expect(200);
    expect(res.headers['x-anomaly-llm']).toMatch(/^failed-open:/);
    expect(res.headers['x-anomaly-blocked']).toBeUndefined();
    const event = await eventFor(prisma, res.headers['x-request-id']);
    expect(event).toMatchObject({
      blocked: false,
      llmScore: null,
      verdict: null,
    });
    expect(event?.heuristicScore).toBeGreaterThan(0.9);
    expect(event?.reasoning).toContain('no model verdict');
  });

  it('dedup: the same payload from the same principal reuses the verdict within the window', async () => {
    script.mode = 'malicious';
    await http()
      .get(`/api/syncr/dedup${SQLI}`)
      .set('User-Agent', 'sqlmap/1.8')
      .expect(403);
    await http()
      .get(`/api/syncr/dedup${SQLI}`)
      .set('User-Agent', 'sqlmap/1.8')
      .expect(403);
    await http()
      .get(`/api/syncr/dedup${SQLI}`)
      .set('User-Agent', 'sqlmap/1.8')
      .expect(403);
    expect(script.calls).toBe(1);
  });

  it('block_on_heuristic: an unmistakable payload is blocked without calling the model', async () => {
    script.mode = 'benign';
    const res = await http()
      .get(`/api/fast/orders${SQLI}`)
      .set('User-Agent', 'sqlmap/1.8')
      .expect(403);
    expect(res.headers['x-anomaly-blocked']).toBe('heuristic');
    expect(script.calls).toBe(0);
    const event = await eventFor(prisma, res.body.requestId);
    expect(event).toMatchObject({ blocked: true, llmScore: null });
    expect(event?.reasoning).toContain('heuristic_fast_block');
  });

  it('async route: the worker classifies off the hot path and stores the verdict', async () => {
    script.mode = 'malicious';
    const res = await http()
      .get(`/api/asyncr/orders${SQLI}`)
      .set('User-Agent', 'sqlmap/1.8')
      .expect(200);
    expect(res.headers['x-anomaly-queued']).toBe('gate');

    const event = await eventFor(prisma, res.headers['x-request-id']);
    expect(event).toMatchObject({
      blocked: false,
      verdict: 'malicious',
      llmScore: MALICIOUS.score,
    });
    const counts = await app.get(AnomalyQueue).counts();
    expect(counts.failed).toBe(0);
  });
});

describe('reactive throttling (integration)', () => {
  let app: NestExpressApplication;
  let redis: RedisService;
  let server: Server;
  let tmp: string;

  beforeAll(async () => {
    const up = await upstream();
    server = up.server;
    tmp = mkdtempSync(join(tmpdir(), 'omnigate-throttle-'));
    const routesFile = join(tmp, 'routes.yaml');
    writeFileSync(
      routesFile,
      `routes:\n  - { service: syncr, upstream: "http://127.0.0.1:${up.port}", auth_required: false, anomaly_mode: sync }\n`,
    );
    ({ app, redis } = await bootApp(routesFile, {
      ANOMALY_AUTO_THROTTLE: 'true',
      ANOMALY_THROTTLE_EVENTS: '3',
      ANOMALY_THROTTLE_WINDOW_S: '300',
      ANOMALY_THROTTLE_SECONDS: '60',
    }));
    script.mode = 'malicious';
    script.calls = 0;
  });

  afterAll(async () => {
    await app?.close();
    server?.closeAllConnections();
    await new Promise<void>((r) => server?.close(() => r()));
    rmSync(tmp, { recursive: true, force: true });
  });

  it('throttles a principal after repeated high-score events, and the limiter enforces it', async () => {
    const http = () => request(app.getHttpServer());
    for (let i = 0; i < 3; i++) {
      await http()
        .get(`/api/syncr/orders${SQLI}&n=${i}`)
        .set('User-Agent', 'sqlmap/1.8')
        .expect(403);
    }

    const keys = await redis.client.keys('throttle:*');
    expect(keys.length).toBeGreaterThanOrEqual(1);
    const ttl = await redis.client.ttl(keys[0]);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);

    // The next request is stopped by the rate limiter before it reaches the anomaly stage.
    const throttled = await http()
      .get('/api/syncr/orders?page=1')
      .set('User-Agent', 'Mozilla/5.0')
      .expect(429);
    expect(throttled.body).toMatchObject({
      type: 'https://gw/errors/rate-limited',
      status: 429,
    });
    expect(throttled.body.detail).toContain('throttled');
    expect(Number(throttled.headers['retry-after'])).toBeGreaterThan(0);
  });
});
