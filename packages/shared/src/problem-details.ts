/** RFC 7807 problem+json body produced by the gateway. See docs/03-API-SPEC.md. */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  requestId: string;
  /** Present on 429 responses; seconds to wait. */
  retryAfter?: number;
}

export const PROBLEM_TYPE_BASE = 'https://gw/errors/';

export const ProblemType = {
  BadRequest: `${PROBLEM_TYPE_BASE}bad-request`,
  Unauthorized: `${PROBLEM_TYPE_BASE}unauthorized`,
  Forbidden: `${PROBLEM_TYPE_BASE}forbidden`,
  /** No route registered for /api/{service}. */
  RouteNotFound: `${PROBLEM_TYPE_BASE}route-not-found`,
  /** Any other unknown path (admin API, health, ...). */
  NotFound: `${PROBLEM_TYPE_BASE}not-found`,
  Conflict: `${PROBLEM_TYPE_BASE}conflict`,
  RateLimited: `${PROBLEM_TYPE_BASE}rate-limited`,
  BadGateway: `${PROBLEM_TYPE_BASE}bad-gateway`,
  GatewayTimeout: `${PROBLEM_TYPE_BASE}gateway-timeout`,
  /** A dependency the request needs (e.g. the credential store) is unreachable. */
  ServiceUnavailable: `${PROBLEM_TYPE_BASE}service-unavailable`,
  Internal: `${PROBLEM_TYPE_BASE}internal`,
} as const;

export type ProblemTypeValue = (typeof ProblemType)[keyof typeof ProblemType];
