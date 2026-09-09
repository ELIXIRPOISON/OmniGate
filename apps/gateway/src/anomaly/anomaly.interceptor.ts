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
import { rateLimitKey, resolvePolicy } from '../rate-limit/policy.js';
import { BodyTooLargeError, hasBody, readRawBody } from './body.js';
import type { AnomalyJobData, FeatureEnvelope } from './envelope.js';
import { type HeuristicResult, scoreHeuristics } from './heuristics.js';
import { AnomalyQueue } from './queue/anomaly.queue.js';
import {
  isTextContentType,
  redactBody,
  redactQuery,
  redactUserAgent,
} from './redactor.js';
import { AnomalyStatsService } from './stats.service.js';

export interface AnomalyVerdictOnRequest {
  heuristic: HeuristicResult;
  envelope?: FeatureEnvelope;
  queued: boolean;
  reason?: AnomalyJobData['reason'];
}

/**
 * Step 6 of the lifecycle (docs/02 §3, docs/06 §2): buffer the body (bounded), redact, score with the
 * heuristics inline, expose X-Anomaly-Score in dev, and queue the feature envelope for the LLM when the
 * score crosses the gate, the request is sampled, or the route is in sync mode. Sync enforcement itself
 * (await + 403) lands in Sprint 6; until then sync routes are queued like async ones.
 */
@Injectable()
export class AnomalyInterceptor implements NestInterceptor {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly stats: AnomalyStatsService,
    private readonly queue: AnomalyQueue,
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

    // 4. Gate: high score, random sample, or sync route -> build the envelope and queue it.
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
      const principalStats10m = await this.stats.principalStats10m(who);
      const envelope: FeatureEnvelope = {
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
        principalStats10m,
      };
      verdict.envelope = envelope;
      const jobId = await this.queue.enqueue({
        envelope,
        reason,
        enqueuedAt: Date.now(),
      });
      verdict.queued = jobId !== undefined;
      if (this.env.EXPOSE_ANOMALY_SCORE)
        res.setHeader('X-Anomaly-Queued', verdict.queued ? reason : 'dropped');
    }
    req.anomaly = verdict;
    return next.handle();
  }
}
