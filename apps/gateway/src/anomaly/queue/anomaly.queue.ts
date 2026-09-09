import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { PinoLogger } from 'nestjs-pino';
import { ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import { ANOMALY_QUEUE, type AnomalyJobData } from '../envelope.js';

const WARN_INTERVAL_MS = 30_000;

/** Producer side of the `anomaly` queue (docs/08 S5-04). Redis down -> jobs are dropped with a throttled warning (docs/02 §6). */
@Injectable()
export class AnomalyQueue implements OnModuleDestroy {
  private readonly connection: Redis;
  private readonly queue: Queue<AnomalyJobData>;
  private lastWarn = 0;

  constructor(
    @Inject(ENV) env: Env,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(AnomalyQueue.name);
    // BullMQ wants its own connection; no offline queue so add() fails fast instead of piling up.
    this.connection = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: null,
      enableOfflineQueue: false,
      lazyConnect: true,
      retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
    });
    this.connection.on('error', (err: Error) =>
      this.warn('anomaly queue redis error', err),
    );
    this.connection
      .connect()
      .catch((err: Error) => this.warn('anomaly queue redis unavailable', err));
    this.queue = new Queue<AnomalyJobData>(ANOMALY_QUEUE, {
      connection: this.connection,
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: 'exponential', delay: 1_000 },
        removeOnComplete: 1_000,
        removeOnFail: 1_000,
      },
    });
  }

  get name(): string {
    return ANOMALY_QUEUE;
  }

  /** Fire-and-forget: never blocks the request. Returns the job id when accepted. */
  async enqueue(data: AnomalyJobData): Promise<string | undefined> {
    if (this.connection.status !== 'ready') {
      this.warn('anomaly job dropped: redis not connected');
      return undefined;
    }
    try {
      const job = await this.queue.add('classify', data, {
        jobId: `${data.envelope.requestId}`,
      });
      return job.id;
    } catch (err) {
      this.warn('anomaly job dropped', err as Error);
      return undefined;
    }
  }

  async counts(): Promise<Record<string, number>> {
    return this.queue.getJobCounts(
      'waiting',
      'active',
      'completed',
      'failed',
      'delayed',
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close().catch(() => undefined);
    this.connection.disconnect();
  }

  private warn(msg: string, err?: Error): void {
    const now = Date.now();
    if (now - this.lastWarn < WARN_INTERVAL_MS) return;
    this.lastWarn = now;
    this.logger.warn({ err_message: err?.message }, msg);
  }
}
