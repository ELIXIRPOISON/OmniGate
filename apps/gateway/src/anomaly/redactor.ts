import type { IncomingHttpHeaders } from 'node:http';
import { REDACTION } from './anomaly.config.js';

export const REDACTED = '[REDACTED]';
export const UNPARSEABLE = '[UNPARSEABLE]';
const TRUNCATED = '…[truncated]';

const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
/** 12-19 digit runs (cards, account numbers) and 10-digit runs (phones), allowing common separators. */
const LONG_NUMBER = /(?<!\d)(?:\d[ -]?){11,18}\d(?!\d)/g;
const PHONE = /(?<!\d)\d{10}(?!\d)/g;

/** Emails and long digit runs are masked in any free text (docs/06 §3). */
export function redactText(text: string): string {
  return text
    .replace(EMAIL, '[EMAIL]')
    .replace(LONG_NUMBER, '[NUM]')
    .replace(PHONE, '[NUM]');
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max) + TRUNCATED;
}

/** Recursively mask values whose key looks like a secret; strings are also text-redacted. */
export function redactJson(value: unknown, depth = 0): unknown {
  if (depth > 20) return '[DEPTH]';
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map((v) => redactJson(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACTION.sensitiveKey.test(k)
        ? REDACTED
        : redactJson(v, depth + 1);
    }
    return out;
  }
  return value;
}

export function redactHeaders(
  headers: IncomingHttpHeaders,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const text = Array.isArray(value) ? value.join(', ') : String(value);
    out[name] = (REDACTION.headers as readonly string[]).includes(
      name.toLowerCase(),
    )
      ? REDACTED
      : redactText(text);
  }
  return out;
}

export function redactQuery(query: string): string {
  const raw = query.startsWith('?') ? query.slice(1) : query;
  if (!raw) return '';
  try {
    const params = new URLSearchParams(raw);
    const parts: string[] = [];
    for (const [k, v] of params) {
      parts.push(
        `${k}=${REDACTION.sensitiveKey.test(k) ? REDACTED : redactText(v)}`,
      );
    }
    return truncate(parts.join('&'), REDACTION.queryMaxChars);
  } catch {
    return truncate(redactText(raw), REDACTION.queryMaxChars);
  }
}

const TEXT_TYPES =
  /^(text\/|application\/(json|x-www-form-urlencoded|xml|javascript|graphql|problem\+json|ld\+json)|.*\+json|.*\+xml)/i;

export function isTextContentType(contentType: string | undefined): boolean {
  return !contentType || TEXT_TYPES.test(contentType.split(';')[0].trim());
}

/**
 * Produce the sample that may be logged or sent to an LLM: JSON bodies get key-based masking,
 * everything textual gets email/number masking, binary bodies are described, and nothing here throws.
 */
export function redactBody(
  body: Buffer | string | null | undefined,
  contentType?: string,
): string {
  try {
    if (body === null || body === undefined) return '';
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
    if (bytes.length === 0) return '';
    if (!isTextContentType(contentType))
      return `[BINARY ${bytes.length} bytes ${contentType?.split(';')[0] ?? ''}]`.trim();

    const text = bytes.toString('utf8');
    const mime = (contentType ?? '').split(';')[0].trim().toLowerCase();
    if (mime === '' || mime === 'application/json' || mime.endsWith('+json')) {
      try {
        return truncate(
          JSON.stringify(redactJson(JSON.parse(text))),
          REDACTION.bodyMaxChars,
        );
      } catch {
        /* not JSON after all: fall through to text redaction */
      }
    }
    if (mime === 'application/x-www-form-urlencoded')
      return redactQuery(text.slice(0, REDACTION.bodyMaxChars * 2));
    return truncate(redactText(text), REDACTION.bodyMaxChars);
  } catch {
    return UNPARSEABLE;
  }
}

export function redactUserAgent(
  ua: string | string[] | undefined,
): string | undefined {
  if (!ua) return undefined;
  return truncate(
    redactText(Array.isArray(ua) ? ua[0] : ua),
    REDACTION.userAgentMaxChars,
  );
}
