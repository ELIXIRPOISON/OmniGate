import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
  RedisContainer,
  type StartedRedisContainer,
} from '@testcontainers/redis';
import request from 'supertest';
import { inject } from 'vitest';
import { applyTestEnv } from './setup/env.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { loadEnv } from '../src/config/env.js';
import { RedisService } from '../src/redis/redis.service.js';

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

const startRedisOn = (hostPort: number) =>
  new RedisContainer('redis:7-alpine')
    .withExposedPorts({ container: 6379, host: hostPort })
    .start();

/** S3-06: Redis dies mid-run -> no 5xx, degraded header; comes back -> limits enforced again. */
describe('chaos: Redis outage (integration)', () => {
  let app: NestExpressApplication;
  let upstream: Server;
  let tmp: string;
  let container: StartedRedisContainer | undefined;
  let hostPort: number;

  beforeAll(async () => {
    hostPort = await freePort();
    container = await startRedisOn(hostPort);

    upstream = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
    const port = (upstream.address() as AddressInfo).port;

    tmp = mkdtempSync(join(tmpdir(), 'omnigate-chaos-'));
    const routesFile = join(tmp, 'routes.yaml');
    writeFileSync(
      routesFile,
      `routes:\n  - { service: open, upstream: "http://127.0.0.1:${port}", auth_required: false }\n`,
    );

    applyTestEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      ROUTES_FILE: routesFile,
      DATABASE_URL: inject('databaseUrl'),
      REDIS_URL: `redis://127.0.0.1:${hostPort}`,
      JWT_SECRET: 'chaos-test-secret-that-is-32-bytes-long',
      API_KEY_PEPPER: 'chaos-pepper-16ch',
      ADMIN_EMAIL: 'admin@example.com',
      ADMIN_PASSWORD: 'admin',
      ADMIN_JWT_SECRET: 'admin-secret-16chars',
      LLM_PROVIDER: 'fake',
      RL_ANON_MAX: '1000',
      RL_FAIL_OPEN: 'true',
    });

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({
      bodyParser: false,
    });
    configureApp(app, loadEnv());
    await app.init();
    await waitForRedis(true);
  });

  afterAll(async () => {
    await app?.close();
    await container?.stop().catch(() => undefined);
    upstream?.closeAllConnections();
    await new Promise<void>((r) => upstream?.close(() => r()));
    rmSync(tmp, { recursive: true, force: true });
  });

  async function waitForRedis(
    ready: boolean,
    timeoutMs = 20_000,
  ): Promise<void> {
    const redis = app.get(RedisService);
    const deadline = Date.now() + timeoutMs;
    while (redis.isReady !== ready && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 100));
    expect(redis.isReady).toBe(ready);
  }

  const http = () => request(app.getHttpServer());

  it('enforces limits, survives the outage without 5xx, and recovers after restart', async () => {
    // healthy: limit headers present
    const healthy = await http().get('/api/open/x').expect(200);
    expect(healthy.headers['x-ratelimit-limit']).toBe('100');
    expect(healthy.headers['x-ratelimit-degraded']).toBeUndefined();
    expect((await http().get('/readyz')).body.redis).toBe('ok');

    // outage
    await container!.stop();
    container = undefined;
    await waitForRedis(false);
    const codes: number[] = [];
    for (let i = 0; i < 20; i++) {
      const res = await http().get('/api/open/x');
      codes.push(res.status);
      expect(res.headers['x-ratelimit-degraded']).toBe('true');
      expect(res.headers['x-ratelimit-limit']).toBeUndefined();
    }
    expect(codes.every((c) => c === 200)).toBe(true);
    expect((await http().get('/readyz').expect(503)).body.redis).toBe('error');

    // recovery on the same address
    container = await startRedisOn(hostPort);
    await waitForRedis(true);
    const recovered = await http().get('/api/open/x').expect(200);
    expect(recovered.headers['x-ratelimit-degraded']).toBeUndefined();
    expect(recovered.headers['x-ratelimit-limit']).toBe('100');
    expect((await http().get('/readyz').expect(200)).body.redis).toBe('ok');
  });
});
