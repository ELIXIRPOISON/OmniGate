import { HttpException } from '@nestjs/common';
import type { Response } from 'express';
import {
  PROBLEM_TYPE_BASE,
  ProblemType,
  type ProblemDetails,
} from '@omnigate/shared';

/** What a thrower supplies; requestId and instance are filled in when the response is written. */
export type ProblemInput = Omit<ProblemDetails, 'requestId' | 'instance'> & {
  instance?: string;
  /** Extra response headers, e.g. Retry-After. */
  headers?: Record<string, string>;
};

/** An HttpException that already knows its RFC 7807 representation. */
export class ProblemException extends HttpException {
  constructor(public readonly problem: ProblemInput) {
    super(problem, problem.status);
  }
}

const STATUS_TITLES: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  408: 'Request Timeout',
  409: 'Conflict',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
};

export function titleFor(status: number): string {
  return STATUS_TITLES[status] ?? (status >= 500 ? 'Server Error' : 'Error');
}

export function typeFor(status: number): string {
  switch (status) {
    case 400:
      return ProblemType.BadRequest;
    case 401:
      return ProblemType.Unauthorized;
    case 403:
      return ProblemType.Forbidden;
    case 404:
      return ProblemType.NotFound;
    case 429:
      return ProblemType.RateLimited;
    case 502:
      return ProblemType.BadGateway;
    case 503:
      return ProblemType.ServiceUnavailable;
    case 504:
      return ProblemType.GatewayTimeout;
    default:
      return status >= 500
        ? ProblemType.Internal
        : `${PROBLEM_TYPE_BASE}http-${status}`;
  }
}

function make(
  status: number,
  type: string,
  detail?: string,
  extra?: Partial<ProblemInput>,
): ProblemException {
  return new ProblemException({
    type,
    title: titleFor(status),
    status,
    detail,
    ...extra,
  });
}

/** Factory for every problem the gateway itself produces (docs/03 status table). */
export const Problems = {
  badRequest: (detail: string) => make(400, ProblemType.BadRequest, detail),
  unauthorized: (detail: string) =>
    make(401, ProblemType.Unauthorized, detail, {
      headers: { 'WWW-Authenticate': 'Bearer realm="omnigate"' },
    }),
  forbidden: (detail: string, headers?: Record<string, string>) =>
    make(403, ProblemType.Forbidden, detail, headers ? { headers } : undefined),
  insufficientScope: (detail: string) =>
    make(403, ProblemType.Forbidden, detail, {
      headers: {
        'WWW-Authenticate':
          'Bearer realm="omnigate", error="insufficient_scope"',
      },
    }),
  serviceUnavailable: (detail: string) =>
    make(503, ProblemType.ServiceUnavailable, detail, {
      headers: { 'Retry-After': '5' },
    }),
  routeNotFound: (service?: string) =>
    make(
      404,
      ProblemType.RouteNotFound,
      service
        ? `No route registered for service "${service}"`
        : 'Request path must be /api/{service}/...',
    ),
  rateLimited: (detail: string, retryAfterSeconds: number) =>
    make(429, ProblemType.RateLimited, detail, {
      retryAfter: retryAfterSeconds,
      headers: { 'Retry-After': String(retryAfterSeconds) },
    }),
  badGateway: (detail: string) => make(502, ProblemType.BadGateway, detail),
  gatewayTimeout: (detail: string) =>
    make(504, ProblemType.GatewayTimeout, detail),
  internal: () =>
    make(500, ProblemType.Internal, 'An unexpected error occurred'),
};

/** Serialise a problem as application/problem+json. Safe to call from outside Nest (e.g. proxy error hooks). */
export function sendProblem(
  res: Response,
  problem: ProblemInput,
  requestId: string,
  instance?: string,
): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  const body: ProblemDetails = {
    type: problem.type,
    title: problem.title,
    status: problem.status,
    ...(problem.detail !== undefined ? { detail: problem.detail } : {}),
    ...((problem.instance ?? instance)
      ? { instance: problem.instance ?? instance }
      : {}),
    requestId,
    ...(problem.retryAfter !== undefined
      ? { retryAfter: problem.retryAfter }
      : {}),
  };
  res.statusCode = problem.status;
  res.setHeader('Content-Type', 'application/problem+json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  for (const [key, value] of Object.entries(problem.headers ?? {}))
    res.setHeader(key, value);
  if (!res.getHeader('x-request-id')) res.setHeader('X-Request-Id', requestId);
  res.end(JSON.stringify(body));
}
