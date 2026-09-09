import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { throttleKey } from '../rate-limit/policy.js';
import { RedisService } from '../redis/redis.service.js';
import type { FeatureEnvelope } from './envelope.js';
import type { Classification } from './llm/llm.service.js';

const ROUTE_ID_TTL_MS = 60_000;
/** Only events at or above this score count toward reactive throttling (docs/06 section 7). */
export const THROTTLE_SCORE_FLOOR = 0.7;

const hitsKey = (principal: string): string => `anomaly:hits:${principal}`;

export interface RecordedEvent {
  id: string | null;
  throttled: boolean;
}

/**
 * Persists anomaly_events and applies the reactive enforcement that async mode relies on
 * (docs/06 section 7): repeated high-score events from one principal set a Redis throttle flag
 * that the RateLimitGuard already honours on later requests.
 */
@Injectable()
export class AnomalyEventsService {
  private readonly routeIds = new Map<
    string,
    { id: string | null; at: number }
  >();

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(AnomalyEventsService.name);
  }

  async record(
    envelope: FeatureEnvelope,
    classification: Classification,
    opts: { blocked: boolean; clientIp?: string | null },
  ): Promise<RecordedEvent> {
    const verdict = classification.verdict;
    const score = verdict?.score ?? envelope.heuristics.score;
    const categories = [
      ...new Set([
        ...(verdict?.categories ?? []),
        ...envelope.heuristics.categories,
      ]),
    ];

    const id = await this.persist(envelope, classification, categories, opts);
    const throttled = await this.maybeThrottle(envelope.principal, score);
    return { id, throttled };
  }

  private async persist(
    envelope: FeatureEnvelope,
    classification: Classification,
    categories: string[],
    opts: { blocked: boolean; clientIp?: string | null },
  ): Promise<string | null> {
    const verdict = classification.verdict;
    const data = {
      requestId: envelope.requestId,
      apiKeyId: apiKeyIdOf(envelope.principal),
      routeId: await this.routeIdFor(envelope.route),
      clientIp: opts.clientIp ?? clientIpOf(envelope.principal),
      method: envelope.method,
      path: envelope.path,
      heuristicScore: envelope.heuristics.score,
      llmScore: verdict?.score ?? null,
      verdict: verdict?.verdict ?? null,
      categories,
      reasoning: verdict?.reasoning ?? classificationNote(classification),
      model: verdict ? classification.model : null,
      llmLatencyMs: classification.latencyMs,
      payloadSample: payloadSample(envelope),
      blocked: opts.blocked,
    };

    try {
      const row = await this.prisma.anomalyEvent.create({
        data,
        select: { id: true },
      });
      return row.id;
    } catch (err) {
      // Most likely a foreign key to a key/route row that is not in the database (yaml routes,
      // test fixtures). Retry once without the references rather than losing the event.
      try {
        const row = await this.prisma.anomalyEvent.create({
          data: { ...data, apiKeyId: null, routeId: null },
          select: { id: true },
        });
        return row.id;
      } catch (retryErr) {
        this.logger.warn(
          {
            request_id: envelope.requestId,
            err_message: (retryErr as Error).message,
            first_error: (err as Error).message,
          },
          'failed to persist anomaly event',
        );
        return null;
      }
    }
  }

  /** Sliding count of recent high-score events; crossing the threshold sets throttle:{principal}. */
  private async maybeThrottle(
    principal: string,
    score: number,
  ): Promise<boolean> {
    if (score < THROTTLE_SCORE_FLOOR) return false;
    const now = Date.now();
    const windowMs = this.env.ANOMALY_THROTTLE_WINDOW_S * 1_000;

    const count = await this.redis.safe(
      'anomaly hit counter',
      async (c) => {
        const key = hitsKey(principal);
        const results =
          (await c
            .multi()
            .zremrangebyscore(key, 0, now - windowMs)
            .zadd(key, now, `${now}`)
            .zcard(key)
            .pexpire(key, windowMs + 1_000)
            .exec()) ?? [];
        return Number(results[2]?.[1] ?? 0);
      },
      0,
    );

    if (count < this.env.ANOMALY_THROTTLE_EVENTS) return false;
    if (!this.env.ANOMALY_AUTO_THROTTLE) {
      this.logger.info(
        {
          principal,
          events: count,
          window_s: this.env.ANOMALY_THROTTLE_WINDOW_S,
        },
        'principal would be throttled (ANOMALY_AUTO_THROTTLE is off)',
      );
      return false;
    }
    await this.redis.safe(
      'anomaly throttle',
      (c) =>
        c.set(
          throttleKey(principal),
          '1',
          'EX',
          this.env.ANOMALY_THROTTLE_SECONDS,
        ),
      null,
    );
    this.logger.warn(
      { principal, events: count, seconds: this.env.ANOMALY_THROTTLE_SECONDS },
      'principal throttled by anomaly policy',
    );
    return true;
  }

  /** yaml routes have no database row yet; the lookup is cached and tolerates Postgres being down. */
  private async routeIdFor(service: string): Promise<string | null> {
    const cached = this.routeIds.get(service);
    if (cached && Date.now() - cached.at < ROUTE_ID_TTL_MS) return cached.id;
    let id: string | null = null;
    try {
      const row = await this.prisma.route.findUnique({
        where: { service },
        select: { id: true },
      });
      id = row?.id ?? null;
    } catch {
      id = null;
    }
    this.routeIds.set(service, { id, at: Date.now() });
    return id;
  }
}

export function apiKeyIdOf(principal: string): string | null {
  return principal.startsWith('api_key:')
    ? principal.slice('api_key:'.length)
    : null;
}

export function clientIpOf(principal: string): string | null {
  return principal.startsWith('anon:') ? principal.slice('anon:'.length) : null;
}

/** VarChar(2000) column: the redacted query and body, already truncated upstream. */
export function payloadSample(envelope: FeatureEnvelope): string {
  const parts = [
    envelope.querySample && `query: ${envelope.querySample}`,
    envelope.bodySample && `body: ${envelope.bodySample}`,
  ]
    .filter(Boolean)
    .join('\n');
  return parts.slice(0, 2_000);
}

function classificationNote(classification: Classification): string | null {
  if (classification.source === 'llm') return null;
  return `no model verdict (${classification.source}${classification.detail ? `: ${classification.detail}` : ''})`.slice(
    0,
    240,
  );
}
