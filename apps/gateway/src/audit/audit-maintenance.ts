import {
  Inject,
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { PinoLogger } from 'nestjs-pino';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { AuditWriter } from './audit-writer.service.js';

export const MAINTENANCE_QUEUE = 'audit-maintenance';
export const MAINTENANCE_JOB = 'partitions';
/** Nightly at 03:15 UTC, away from the top of the hour. */
export const MAINTENANCE_CRON = '15 3 * * *';

/**
 * Creates next month's partition and drops expired ones (docs/04 section 3, docs/08 S7-01).
 * A BullMQ repeatable job rather than a timer, so exactly one replica runs it.
 */
@Injectable()
export class AuditMaintenance implements OnModuleInit, OnModuleDestroy {
  private queue?: Queue;
  private worker?: Worker;
  private connections: Redis[] = [];

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly writer: AuditWriter,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(AuditMaintenance.name);
  }

  async onModuleInit(): Promise<void> {
    if (!this.env.WORKER_INLINE) {
      this.logger.info('audit maintenance disabled (WORKER_INLINE=false)');
      return;
    }
    this.queue = new Queue(MAINTENANCE_QUEUE, {
      connection: this.connection(),
    });
    this.worker = new Worker(
      MAINTENANCE_QUEUE,
      () => this.writer.maintainPartitions(),
      {
        connection: this.connection(),
        concurrency: 1,
      },
    );
    this.worker.on('failed', (_job, err) =>
      this.logger.warn(
        { err_message: err.message },
        'audit partition maintenance failed',
      ),
    );
    this.worker.on('error', () => undefined);

    try {
      await this.queue.upsertJobScheduler(
        MAINTENANCE_JOB,
        { pattern: MAINTENANCE_CRON },
        { name: MAINTENANCE_JOB },
      );
      this.logger.info(
        { cron: MAINTENANCE_CRON, retention_days: this.env.LOG_RETENTION_DAYS },
        'audit partition maintenance scheduled',
      );
    } catch (err) {
      this.logger.warn(
        { err_message: (err as Error).message },
        'could not schedule audit partition maintenance',
      );
    }

    // Also run once at boot so a fresh deploy always has a partition to write into.
    this.writer
      .maintainPartitions()
      .catch((err: unknown) =>
        this.logger.warn(
          { err_message: (err as Error).message },
          'initial partition check failed',
        ),
      );
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close().catch(() => undefined);
    await this.queue?.close().catch(() => undefined);
    for (const c of this.connections) c.disconnect();
  }

  private connection(): Redis {
    const c = new Redis(this.env.REDIS_URL, {
      maxRetriesPerRequest: null,
      lazyConnect: true,
      retryStrategy: (attempt) => Math.min(attempt * 500, 10_000),
    });
    c.on('error', () => undefined);
    void c.connect().catch(() => undefined);
    this.connections.push(c);
    return c;
  }
}
