import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const API_KEY_PREFIX = 'gw_live_';
const RANDOM_LENGTH = 32;
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
/** Full key: gw_live_ + 32 base62 chars (docs/03). */
export const API_KEY_REGEX = /^gw_live_[0-9A-Za-z]{32}$/;
/** Stored/displayed lookup prefix: "gw_live_" + first 8 random chars. */
export const LOOKUP_PREFIX_LENGTH = API_KEY_PREFIX.length + 8;

export function isApiKeyFormat(value: unknown): value is string {
  return typeof value === 'string' && API_KEY_REGEX.test(value);
}

export function lookupPrefixOf(rawKey: string): string {
  return rawKey.slice(0, LOOKUP_PREFIX_LENGTH);
}

/** sha256(pepper + raw), hex. Rotating the pepper invalidates every key (docs/10 §7). */
export function hashApiKey(rawKey: string, pepper: string): string {
  return createHash('sha256').update(pepper).update(rawKey).digest('hex');
}

export function hashesMatch(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ba.length !== bb.length || ba.length === 0) return false;
  return timingSafeEqual(ba, bb);
}

function randomBase62(length: number): string {
  // Rejection sampling keeps the distribution uniform (256 % 62 != 0).
  let out = '';
  while (out.length < length) {
    for (const byte of randomBytes(length)) {
      if (byte < 248) {
        out += BASE62[byte % 62];
        if (out.length === length) break;
      }
    }
  }
  return out;
}

export interface GeneratedApiKey {
  /** Shown to the operator exactly once. */
  raw: string;
  prefix: string;
  keyHash: string;
}

export function generateApiKey(pepper: string): GeneratedApiKey {
  const raw = API_KEY_PREFIX + randomBase62(RANDOM_LENGTH);
  return { raw, prefix: lookupPrefixOf(raw), keyHash: hashApiKey(raw, pepper) };
}
