import { Injectable } from '@nestjs/common';
import type { ReadyzResponse } from '@omnigate/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { RedisService } from '../redis/redis.service.js';
import { RouteRegistry } from '../routing/route-registry.service.js';

const CHECK_TIMEOUT_MS = 1_000;

@Injectable()
export class HealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly registry: RouteRegistry,
  ) {}

  /** Redis PING and Postgres SELECT 1, each bounded to one second (docs/03 §Health). */
  async readiness(): Promise<ReadyzResponse> {
    const [redisOk, postgresOk] = await Promise.all([
      this.redis.ping(CHECK_TIMEOUT_MS),
      withTimeout(this.prisma.$queryRaw`SELECT 1`, CHECK_TIMEOUT_MS)
        .then(() => true)
        .catch(() => false),
    ]);
    return {
      status: redisOk && postgresOk ? 'ok' : 'degraded',
      redis: redisOk ? 'ok' : 'error',
      postgres: postgresOk ? 'ok' : 'error',
      routes: this.registry.size,
    };
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('timeout')), ms).unref(),
    ),
  ]);
}
