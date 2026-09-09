import {
  type AttackCategory,
  HEURISTIC_THRESHOLDS as T,
  INJECTION_PATTERNS,
  SCANNER_USER_AGENTS,
  SIGNAL_WEIGHTS,
  type SignalName,
} from './anomaly.config.js';

/** Everything the scorer needs; Redis-derived numbers are gathered by the caller so this stays pure and benchmarkable. */
export interface HeuristicInput {
  method: string;
  /** Pathname as requested (not yet redacted; the scorer only pattern-matches it). */
  path: string;
  /** Raw query string, with or without `?`. */
  query: string;
  /** Text form of the body for pattern/entropy analysis, null for binary or absent bodies. */
  bodyText: string | null;
  bodyBytes: number;
  userAgent?: string;
  /** Route's allowed methods; ['*'] means any. */
  routeMethods: string[];
  stats: {
    /** Requests by this principal in the last 10 s (from the rate-limit sorted set). */
    burstCount10s: number;
    /** Max requests of the applicable policy. */
    policyMax: number;
    distinctPaths60s: number;
    authFailures60s: number;
    /** Rolling body-size statistics for the route, null until enough samples exist. */
    routeBody: { n: number; mean: number; std: number } | null;
  };
}

export type SignalScores = Record<SignalName, number>;

export interface HeuristicResult {
  /** Noisy-OR of weighted signals, 0..1. */
  score: number;
  signals: SignalScores;
  /** Injection categories that matched, plus behavioural categories implied by the strongest signals. */
  categories: AttackCategory[];
  /** Names of the injection signatures that matched (for the envelope / debugging). */
  matchedPatterns: string[];
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const ramp = (x: number, low: number, high: number): number =>
  clamp01((x - low) / (high - low));

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text.replace(/\+/g, ' '));
  } catch {
    return text;
  }
}

/** Shannon entropy in bits per character. */
export function shannonEntropy(text: string): number {
  if (text.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of text) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const c of counts.values()) {
    const p = c / text.length;
    h -= p * Math.log2(p);
  }
  return h;
}

export function injectionSignal(
  input: Pick<HeuristicInput, 'path' | 'query' | 'bodyText'>,
): {
  score: number;
  categories: AttackCategory[];
  matched: string[];
} {
  const haystack = [input.path, input.query, input.bodyText ?? '']
    .map((part) => safeDecode(safeDecode(part)).toLowerCase())
    .join('\n');
  const categories = new Set<AttackCategory>();
  const matched: string[] = [];
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.re.test(haystack)) {
      categories.add(pattern.category);
      matched.push(pattern.name);
    }
  }
  // docs/06 §4: count of distinct hits, capped at 1
  return {
    score: matched.length > 0 ? 1 : 0,
    categories: [...categories],
    matched,
  };
}

export function bodySizeSignal(
  bodyBytes: number,
  routeBody: HeuristicInput['stats']['routeBody'],
): number {
  if (!routeBody || routeBody.n < T.bodyStatsMinSamples || bodyBytes === 0)
    return 0;
  const std = Math.max(routeBody.std, 1);
  const z = (bodyBytes - routeBody.mean) / std;
  return ramp(z, T.bodyZMin, T.bodyZMax);
}

export function entropySignal(bodyText: string | null): number {
  if (!bodyText || bodyText.length < T.entropyMinBytes) return 0;
  return ramp(shannonEntropy(bodyText), T.entropyLow, T.entropyHigh);
}

export function burstSignal(burstCount10s: number, policyMax: number): number {
  if (policyMax <= 0) return 0;
  return clamp01(burstCount10s / policyMax);
}

export function pathEnumSignal(distinctPaths60s: number): number {
  return ramp(distinctPaths60s, T.pathEnumLow, T.pathEnumHigh);
}

export function userAgentSignal(userAgent: string | undefined): number {
  if (!userAgent || userAgent.trim() === '') return T.missingUserAgent;
  const ua = userAgent.toLowerCase();
  return SCANNER_USER_AGENTS.some((s) => ua.includes(s)) ? 1 : 0;
}

export function authFailuresSignal(authFailures60s: number): number {
  return ramp(authFailures60s, T.authFailLow, T.authFailHigh);
}

export function methodMismatchSignal(
  method: string,
  routeMethods: string[],
): number {
  if (routeMethods.includes('*')) return 0;
  return routeMethods.map((m) => m.toUpperCase()).includes(method.toUpperCase())
    ? 0
    : 1;
}

/** 1 - Π(1 - wᵢ·sᵢ): several weak signals add up, one strong signal dominates (docs/06 §4). */
export function noisyOr(signals: SignalScores): number {
  let product = 1;
  for (const name of Object.keys(SIGNAL_WEIGHTS) as SignalName[]) {
    product *= 1 - SIGNAL_WEIGHTS[name] * clamp01(signals[name] ?? 0);
  }
  return Math.round((1 - product) * 1000) / 1000;
}

export function scoreHeuristics(input: HeuristicInput): HeuristicResult {
  const injection = injectionSignal(input);
  const signals: SignalScores = {
    injection_patterns: injection.score,
    body_size_z: bodySizeSignal(input.bodyBytes, input.stats.routeBody),
    entropy: entropySignal(input.bodyText),
    burst: burstSignal(input.stats.burstCount10s, input.stats.policyMax),
    path_enum: pathEnumSignal(input.stats.distinctPaths60s),
    ua_anomaly: userAgentSignal(input.userAgent),
    auth_failures: authFailuresSignal(input.stats.authFailures60s),
    method_mismatch: methodMismatchSignal(input.method, input.routeMethods),
  };

  const categories = new Set<AttackCategory>(injection.categories);
  if (signals.path_enum >= 0.5) categories.add('enumeration');
  if (signals.burst >= 0.8 && signals.path_enum >= 0.3)
    categories.add('scraping');
  if (signals.auth_failures >= 0.5) categories.add('credential_stuffing');
  if (signals.ua_anomaly >= 1) categories.add('enumeration');

  return {
    score: noisyOr(signals),
    signals,
    categories: [...categories],
    matchedPatterns: injection.matched,
  };
}
