import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Response } from 'express';
import { performance } from 'node:perf_hooks';
import { formatPrincipal, type ProblemDetails } from '@omnigate/shared';
import { pathOf, type GatewayRequest } from '../common/gateway-request.js';
import { AuditWriter } from './audit-writer.service.js';
import { normalizeIp, truncate } from './audit-buffer.js';

/**
 * Step 8 of the lifecycle (docs/02 section 3): record one row per request, without ever blocking it.
 * The record is assembled when the response finishes and handed to a bounded buffer; the writer
 * drains it in batches. Errors here must never reach the client, so everything is guarded.
 *
 * This is middleware rather than the interceptor the plan sketched, because a request rejected
 * before the controller - an unknown service, for instance - never reaches an interceptor, and
 * those 404s are exactly the traffic an operator wants to see.
 */
@Injectable()
export class AuditMiddleware implements NestMiddleware {
  constructor(private readonly writer: AuditWriter) {}

  use(req: GatewayRequest, res: Response, next: NextFunction): void {
    const startedAt = performance.now();
    res.once('finish', () => {
      try {
        this.record(req, res, performance.now() - startedAt);
      } catch {
        /* auditing must never affect the response */
      }
    });
    next();
  }

  private record(req: GatewayRequest, res: Response, latencyMs: number): void {
    const locals = res.locals as {
      upstream_ms?: number;
      rate_limited?: boolean;
      cache_status?: string;
      anomaly_score?: number;
      problem_type?: string;
    };
    const resBytes = Number(res.getHeader('content-length'));
    const reqBytes = Number(req.headers['content-length']);

    this.writer.add({
      ts: new Date(),
      requestId: String(req.id ?? ''),
      apiKeyId: req.principal?.type === 'api_key' ? req.principal.id : null,
      routeId: req.gw?.route.id ?? null,
      principal: req.principal
        ? truncate(formatPrincipal(req.principal), 80)
        : null,
      method: req.method,
      path: truncate(pathOf(req.originalUrl ?? req.url ?? '/'), 2_048) ?? '/',
      statusCode: res.statusCode,
      latencyMs: Math.round(latencyMs),
      upstreamMs:
        typeof locals.upstream_ms === 'number' ? locals.upstream_ms : null,
      clientIp: normalizeIp(req.ip ?? req.socket?.remoteAddress),
      userAgent: truncate(headerValue(req.headers['user-agent']), 512),
      reqBytes: Number.isFinite(reqBytes)
        ? reqBytes
        : (req.rawBody?.length ?? null),
      resBytes: Number.isFinite(resBytes) ? resBytes : null,
      rateLimited: locals.rate_limited === true,
      cacheStatus: locals.cache_status ?? null,
      anomalyScore:
        typeof locals.anomaly_score === 'number' ? locals.anomaly_score : null,
      errorType: errorSlug(locals.problem_type, res.statusCode),
    });
  }
}

function headerValue(value: string | string[] | undefined): string | null {
  if (!value) return null;
  return Array.isArray(value) ? value[0] : value;
}

/** The problem `type` URI reduced to its last segment, e.g. "rate-limited". */
export function errorSlug(
  problemType: string | undefined,
  statusCode: number,
): string | null {
  if (problemType) return truncate(problemType.split('/').pop() ?? null, 64);
  return statusCode >= 400 ? `http-${statusCode}` : null;
}

/** Called by the problem filter so audit rows carry the gateway's own error classification. */
export function markProblem(
  res: Response,
  problem: Pick<ProblemDetails, 'type'>,
): void {
  (res.locals as { problem_type?: string }).problem_type = problem.type;
}
