import {
  Inject,
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { Redis } from 'ioredis';
import { PinoLogger } from 'nestjs-pino';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';

const ERROR_LOG_INTERVAL_MS = 30_000;

/**
 * Thin wrapper around one ioredis client. The gateway must keep serving when Redis is down
 * (docs/02 §6), so the client never queues commands offline and every caller goes through
 * `safe()` which turns failures into a fallback value plus a rate-limited warning.
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  readonly client: Redis;
  private lastErrorLog = 0;

  constructor(
    @Inject(ENV) env: Env,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(RedisService.name);
    this.client = new Redis(env.REDIS_URL, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 2_000,
      commandTimeout: 1_000,
      retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
    });
    // ioredis emits 'error' on every failed (re)connect; without a listener that would crash the process.
    this.client.on('error', (err: Error) =>
      this.warnThrottled('redis connection error', err),
    );
    this.client.on('ready', () => this.logger.info('redis connected'));
  }

  async onModuleInit(): Promise<void> {
    // Do not await: a missing Redis must not block boot (auth still works, limits fail open).
    this.client
      .connect()
      .catch((err: Error) =>
        this.warnThrottled('redis unavailable at boot', err),
      );
  }

  async onModuleDestroy(): Promise<void> {
    this.client.disconnect();
  }

  get isReady(): boolean {
    return this.client.status === 'ready';
  }

  /** Run a Redis operation; on any failure log (throttled) and return the fallback instead of throwing. */
  async safe<T>(
    what: string,
    fn: (client: Redis) => Promise<T>,
    fallback: T,
  ): Promise<T> {
    if (!this.isReady) return fallback;
    try {
      return await fn(this.client);
    } catch (err) {
      this.warnThrottled(`redis ${what} failed`, err as Error);
      return fallback;
    }
  }

  /** PING with a hard deadline, for /readyz. */
  async ping(timeoutMs = 1_000): Promise<boolean> {
    if (!this.isReady) return false;
    try {
      const pong = await Promise.race([
        this.client.ping(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), timeoutMs),
        ),
      ]);
      return pong === 'PONG';
    } catch {
      return false;
    }
  }

  private warnThrottled(msg: string, err: Error): void {
    const now = Date.now();
    if (now - this.lastErrorLog < ERROR_LOG_INTERVAL_MS) return;
    this.lastErrorLog = now;
    this.logger.warn(
      { err_message: err.message, code: (err as NodeJS.ErrnoException).code },
      msg,
    );
  }
}
