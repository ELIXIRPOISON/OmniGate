import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const REQUEST_ID_HEADER = 'x-request-id';
const VALID_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

export function isValidRequestId(value: unknown): value is string {
  return typeof value === 'string' && VALID_REQUEST_ID.test(value);
}

export function newRequestId(): string {
  return randomUUID();
}

/**
 * Reuse a well-formed inbound X-Request-Id, otherwise mint one.
 * Idempotent per request. Mirrors the id on the response and rewrites the inbound
 * header so the proxy forwards exactly the id we logged.
 */
export function ensureRequestId(
  req: IncomingMessage,
  res: ServerResponse,
): string {
  const r = req as IncomingMessage & { id?: unknown };
  let id = typeof r.id === 'string' ? r.id : undefined;
  if (!id) {
    const inbound = req.headers[REQUEST_ID_HEADER];
    const candidate = Array.isArray(inbound) ? inbound[0] : inbound;
    id = isValidRequestId(candidate) ? candidate : newRequestId();
    r.id = id;
    req.headers[REQUEST_ID_HEADER] = id;
  }
  if (!res.headersSent && !res.getHeader(REQUEST_ID_HEADER)) {
    res.setHeader('X-Request-Id', id);
  }
  return id;
}
