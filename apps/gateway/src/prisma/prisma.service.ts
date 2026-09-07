import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { PrismaClient } from '../generated/prisma/client.js';

/**
 * One Prisma client for the process (Prisma 7: driver adapter, no engine binary).
 * Connects lazily on first query so the gateway boots and keeps proxying even when
 * Postgres is unreachable; /readyz reports the gap.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(@Inject(ENV) env: Env) {
    super({
      adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
      log: ['warn', 'error'],
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
