import type { IncomingHttpHeaders } from 'node:http';

/** RFC 7230 §6.1 hop-by-hop headers plus the ones docs/03 lists explicitly. */
export const HOP_BY_HOP_HEADERS = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'trailers',
  'transfer-encoding',
  'upgrade',
] as const;

/** Credentials meant for the gateway only; never forwarded to an upstream. */
export const GATEWAY_ONLY_HEADERS = ['x-api-key'] as const;

export interface ForwardingContext {
  requestId: string;
  /** Peer address of the TCP connection. */
  remoteAddress: string;
  /** Scheme as seen by Express (already trust-proxy aware). */
  protocol: string;
  /** Host header the client sent. */
  host?: string;
  /** When true, inbound X-Forwarded-* from the previous hop are kept and appended to (T3). */
  trustProxy: boolean;
}

/**
 * Mutates the inbound header map in place so the proxy engine, which copies req.headers verbatim,
 * sends exactly what docs/03 specifies: no hop-by-hop, no X-API-Key, no spoofable X-Gateway-*,
 * plus X-Request-Id and X-Forwarded-For/Proto/Host.
 */
export function prepareUpstreamHeaders(
  headers: IncomingHttpHeaders,
  ctx: ForwardingContext,
): IncomingHttpHeaders {
  const connectionTokens = String(headers.connection ?? '')
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);

  for (const name of [
    ...HOP_BY_HOP_HEADERS,
    ...connectionTokens,
    ...GATEWAY_ONLY_HEADERS,
  ]) {
    delete headers[name];
  }
  for (const name of Object.keys(headers)) {
    if (name.startsWith('x-gateway-')) delete headers[name];
  }

  const inboundFor = ctx.trustProxy ? headers['x-forwarded-for'] : undefined;
  headers['x-forwarded-for'] = inboundFor
    ? `${inboundFor}, ${ctx.remoteAddress}`
    : ctx.remoteAddress;

  const inboundProto = ctx.trustProxy
    ? headers['x-forwarded-proto']
    : undefined;
  headers['x-forwarded-proto'] = inboundProto || ctx.protocol;

  const inboundHost = ctx.trustProxy ? headers['x-forwarded-host'] : undefined;
  const host = inboundHost || ctx.host;
  if (host) headers['x-forwarded-host'] = host;
  else delete headers['x-forwarded-host'];

  headers['x-request-id'] = ctx.requestId;
  return headers;
}
