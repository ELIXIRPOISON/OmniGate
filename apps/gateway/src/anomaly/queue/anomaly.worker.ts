import {
  Inject,
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { PinoLogger } from 'nestjs-pino';
import { ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import { ANOMALY_QUEUE, type AnomalyJobData } from '../envelope.js';
import { AnomalyProcessor } from './anomaly.processor.js';

export const WORKER_CONCURRENCY = 4;

/** Runs the queue processor in this process when WORKER_INLINE=true (ADR-005; split out later via env). */
@Injectable()
export class AnomalyWorker implements OnModuleInit, OnModuleDestroy {
  private worker?: Worker<AnomalyJobData>;
  private connection?: Redis;

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly processor: AnomalyProcessor,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(AnomalyWorker.name);
  }

  onModuleInit(): void {
    if (!this.env.WORKER_INLINE) {
      this.logger.info('inline anomaly worker disabled (WORKER_INLINE=false)');
      return;
    }
    // Blocking commands need their own connection and no per-request retry cap (BullMQ requirement).
    this.connection = new Redis(this.env.REDIS_URL, {
      maxRetriesPerRequest: null,
      lazyConnect: true,
      retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
    });
    this.connection.on('error', () => undefined);
    this.worker = new Worker<AnomalyJobData>(
      ANOMALY_QUEUE,
      (job) => this.processor.process(job),
      {
        connection: this.connection,
        concurrency: WORKER_CONCURRENCY,
        autorun: true,
      },
    );
    this.worker.on('failed', (job, err) =>
      this.logger.warn(
        { job_id: job?.id, err_message: err.message },
        'anomaly job failed',
      ),
    );
    this.worker.on('error', (err) =>
      this.logger.warn({ err_message: err.message }, 'anomaly worker error'),
    );
    this.logger.info(
      { queue: ANOMALY_QUEUE, concurrency: WORKER_CONCURRENCY },
      'inline anomaly worker started',
    );
  }

  get running(): boolean {
    return this.worker?.isRunning() ?? false;
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close().catch(() => undefined);
    this.connection?.disconnect();
  }
}
