import type { AttackCategory, SignalName } from './anomaly.config.js';

/** What the LLM (Sprint 6) and the eval set see: redacted, truncated, plus short-term sender statistics (docs/06 §5). */
export interface FeatureEnvelope {
  requestId: string;
  route: string;
  method: string;
  path: string;
  /** "<type>:<id>" */
  principal: string;
  /** Not available in v1 (no geo lookup); kept for schema compatibility with docs/06 §5. */
  clientCountry: string | null;
  userAgent: string | null;
  querySample: string;
  bodySample: string;
  heuristics: {
    score: number;
    signals: Record<SignalName, number>;
    categories: AttackCategory[];
    matchedPatterns: string[];
  };
  principalStats10m: {
    requests: number;
    errorRate: number;
    distinctPaths: number;
  };
}

export const ANOMALY_QUEUE = 'anomaly';

export interface AnomalyJobData {
  envelope: FeatureEnvelope;
  /** Why this request was queued (docs/06 §2). */
  reason: 'gate' | 'sample' | 'sync';
  enqueuedAt: number;
}
