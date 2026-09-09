import {
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { Response } from 'express';
import { PinoLogger } from 'nestjs-pino';
import type { Observable } from 'rxjs';
import { formatPrincipal } from '@omnigate/shared';
import { pathOf, type GatewayRequest } from '../common/gateway-request.js';
import { Problems } from '../common/problem/problem.js';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import type { RouteConfig } from '../config/routes.js';
import { rateLimitKey, resolvePolicy } from '../rate-limit/policy.js';
import { BodyTooLargeError, hasBody, readRawBody } from './body.js';
import type { AnomalyJobData, FeatureEnvelope } from './envelope.js';
import { AnomalyEventsService } from './events.service.js';
import { type HeuristicResult, scoreHeuristics } from './heuristics.js';
import type { Classification } from './llm/llm.service.js';
import { LlmService } from './llm/llm.service.js';
import { AnomalyQueue } from './queue/anomaly.queue.js';
import {
  isTextContentType,
  redactBody,
  redactQuery,
  redactUserAgent,
} from './redactor.js';
import { AnomalyStatsService } from './stats.service.js';

/** Heuristic score above which an unambiguous injection may be blocked without the model. */
export const HEURISTIC_FAST_BLOCK_SCORE = 0.95;

export interface AnomalyVerdictOnRequest {
  heuristic: HeuristicResult;
  envelope?: FeatureEnvelope;
  queued: boolean;
  reason?: AnomalyJobData['reason'];
  /** Present on sync routes, where the verdict is awaited inline. */
  classification?: Classification;
  blocked?: boolean;
}

/**
 * Step 6 of the lifecycle (docs/02 section 3, docs/06 section 2): buffer the body (bounded), redact,
 * score with the heuristics inline, expose X-Anomaly-Score in dev, then either queue the envelope for
 * asynchronous classification or - on a route that opted into sync mode - await the verdict within a
 * hard budget and answer 403 when it is above the block threshold. Any model trouble fails open.
 */
@Injectable()
export class AnomalyInterceptor implements NestInterceptor {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly stats: AnomalyStatsService,
    private readonly queue: AnomalyQueue,
    private readonly llm: LlmService,
    private readonly events: AnomalyEventsService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(AnomalyInterceptor.name);
  }

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const req = context.switchToHttp().getRequest<GatewayRequest>();
    const res = context.switchToHttp().getResponse<Response>();
    const route = req.gw?.route;
    const principal = req.principal;
    if (!route || !principal || route.anomaly_mode === 'off')
      return next.handle();

    // 1. Body: buffered once, screened here, replayed by the proxy (docs/08 R4).
    if (hasBody(req) && req.rawBody === undefined) {
      try {
        req.rawBody = await readRawBody(req, this.env.MAX_BODY_BYTES);
      } catch (err) {
        if (err instanceof BodyTooLargeError) {
          throw Problems.badRequest(
            `Request body exceeds the limit of ${err.limit} bytes`,
          );
        }
        throw err;
      }
    }
    const body = req.rawBody ?? Buffer.alloc(0);
    const contentType = req.headers['content-type'];
    const bodyText =
      body.length > 0 && isTextContentType(contentType)
        ? body.toString('utf8')
        : null;

    // 2. Behavioural stats (one Redis round trip) + 3. inline heuristics.
    const who = formatPrincipal(principal);
    const url = req.originalUrl ?? req.url ?? '/';
    const q = url.indexOf('?');
    const path = pathOf(url);
    const query = q === -1 ? '' : url.slice(q);
    const policy = resolvePolicy(route, req.keyPolicy, this.env);
    const clientIp = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    const stats = await this.stats.recordAndRead({
      principal: who,
      clientIp,
      route: route.service,
      path,
      bodyBytes: body.length,
      rateLimitKey: rateLimitKey(policy.id, who),
    });
    const userAgent = redactUserAgent(req.headers['user-agent']);
    const heuristic = scoreHeuristics({
      method: req.method,
      path,
      query,
      bodyText,
      bodyBytes: body.length,
      userAgent,
      routeMethods: route.methods,
      stats: { ...stats, policyMax: policy.maxRequests },
    });

    res.locals.anomaly_score = heuristic.score;
    if (this.env.EXPOSE_ANOMALY_SCORE) {
      res.setHeader('X-Anomaly-Score', heuristic.score.toFixed(3));
      const top = Object.entries(heuristic.signals)
        .filter(([, v]) => v > 0)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 4)
        .map(([k, v]) => `${k}=${v.toFixed(2)}`)
        .join(',');
      if (top) res.setHeader('X-Anomaly-Signals', top);
    }
    res.once('finish', () => {
      if (res.statusCode >= 400) this.stats.recordError(who);
    });

    const buildEnvelope = async (): Promise<FeatureEnvelope> => ({
      requestId: String(req.id),
      route: route.service,
      method: req.method,
      path,
      principal: who,
      clientCountry: null,
      userAgent: userAgent ?? null,
      querySample: redactQuery(query),
      bodySample: redactBody(body, contentType),
      heuristics: {
        score: heuristic.score,
        signals: heuristic.signals,
        categories: heuristic.categories,
        matchedPatterns: heuristic.matchedPatterns,
      },
      principalStats10m: await this.stats.principalStats10m(who),
    });

    // 4. Fast path: an unmistakable payload on a route that opted in is blocked without the model.
    if (this.shouldFastBlock(route, heuristic)) {
      const envelope = await buildEnvelope();
      const classification: Classification = {
        verdict: null,
        source: 'skipped',
        detail: 'heuristic_fast_block',
        latencyMs: null,
        model: this.llm.model,
      };
      req.anomaly = {
        heuristic,
        envelope,
        queued: false,
        blocked: true,
        classification,
      };
      await this.events.record(envelope, classification, {
        blocked: true,
        clientIp,
      });
      this.markBlocked(res, 'heuristic');
      throw Problems.forbidden('Request blocked by anomaly policy');
    }

    // 5. Gate: high score, random sample, or a sync route.
    const reason: AnomalyJobData['reason'] | undefined =
      heuristic.score >= this.env.ANOMALY_GATE_THRESHOLD
        ? 'gate'
        : route.anomaly_mode === 'sync'
          ? 'sync'
          : Math.random() < this.env.ANOMALY_SAMPLE_RATE
            ? 'sample'
            : undefined;

    const verdict: AnomalyVerdictOnRequest = {
      heuristic,
      queued: false,
      reason,
    };
    if (reason) {
      const envelope = await buildEnvelope();
      verdict.envelope = envelope;

      if (route.anomaly_mode === 'sync') {
        await this.enforceSync(envelope, verdict, res, clientIp);
      } else {
        const jobId = await this.queue.enqueue({
          envelope,
          reason,
          enqueuedAt: Date.now(),
        });
        verdict.queued = jobId !== undefined;
        if (this.env.EXPOSE_ANOMALY_SCORE) {
          res.setHeader(
            'X-Anomaly-Queued',
            verdict.queued ? reason : 'dropped',
          );
        }
      }
    }
    req.anomaly = verdict;
    return next.handle();
  }

  private shouldFastBlock(
    route: RouteConfig,
    heuristic: HeuristicResult,
  ): boolean {
    return (
      route.block_on_heuristic &&
      heuristic.signals.injection_patterns >= 1 &&
      heuristic.score >= HEURISTIC_FAST_BLOCK_SCORE
    );
  }

  /**
   * Sync mode (docs/06 section 7): await the verdict within LLM_TIMEOUT_SYNC_MS. A score at or above
   * ANOMALY_BLOCK_THRESHOLD answers 403; a timeout, an error or a skipped call allows the request.
   */
  private async enforceSync(
    envelope: FeatureEnvelope,
    verdict: AnomalyVerdictOnRequest,
    res: Response,
    clientIp: string,
  ): Promise<void> {
    const classification = await this.llm.classify(
      envelope,
      this.env.LLM_TIMEOUT_SYNC_MS,
    );
    verdict.classification = classification;
    const score = classification.verdict?.score;

    if (score !== undefined && score >= this.env.ANOMALY_BLOCK_THRESHOLD) {
      verdict.blocked = true;
      await this.events.record(envelope, classification, {
        blocked: true,
        clientIp,
      });
      this.markBlocked(res, 'llm');
      this.logger.warn(
        {
          request_id: envelope.requestId,
          principal: envelope.principal,
          route: envelope.route,
          llm_score: score,
          categories: classification.verdict?.categories,
        },
        'request blocked by anomaly policy',
      );
      throw Problems.forbidden('Request blocked by anomaly policy');
    }

    // Allowed: store the event off the request path so sync mode only pays for the model call.
    void this.events
      .record(envelope, classification, { blocked: false, clientIp })
      .catch((err: unknown) =>
        this.logger.warn(
          { err_message: (err as Error).message },
          'failed to record anomaly event',
        ),
      );
    if (this.env.EXPOSE_ANOMALY_SCORE) {
      res.setHeader('X-Anomaly-Queued', 'sync');
      if (score !== undefined)
        res.setHeader('X-Anomaly-Llm-Score', score.toFixed(3));
      else if (classification.source !== 'llm')
        res.setHeader(
          'X-Anomaly-Llm',
          `failed-open:${classification.detail ?? classification.source}`,
        );
    }
  }

  private markBlocked(res: Response, by: 'heuristic' | 'llm'): void {
    res.locals.anomaly_blocked = true;
    if (this.env.EXPOSE_ANOMALY_SCORE) res.setHeader('X-Anomaly-Blocked', by);
  }
}
