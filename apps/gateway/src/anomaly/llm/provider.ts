import { z } from 'zod';
import type { FeatureEnvelope } from '../envelope.js';

/** Categories the classifier may return (docs/06 §6.1). */
export const VERDICT_CATEGORIES = [
  'sqli',
  'xss',
  'traversal',
  'cmd_injection',
  'ssti',
  'scraping',
  'credential_stuffing',
  'enumeration',
  'dos',
  'other',
] as const;

/** Structured output contract. Everything a provider returns is validated against this before use (T14). */
export const verdictSchema = z.object({
  score: z.coerce.number().min(0).max(1),
  verdict: z.enum(['benign', 'suspicious', 'malicious']),
  categories: z
    .array(z.string())
    .default([])
    .transform((list) =>
      list
        .map((c) => c.toLowerCase().trim())
        .filter((c): c is (typeof VERDICT_CATEGORIES)[number] =>
          (VERDICT_CATEGORIES as readonly string[]).includes(c),
        )
        .slice(0, 6),
    ),
  reasoning: z
    .string()
    .max(1_000)
    .default('')
    .transform((r) => r.slice(0, 240)),
});

export type Verdict = z.output<typeof verdictSchema>;

export interface ClassifyOptions {
  timeoutMs: number;
}

/** One method, so a new backend is one small class (docs/06 §6.1). */
export interface LlmProvider {
  /** Value of LLM_PROVIDER this adapter serves. */
  readonly name: string;
  /** Model identifier reported on stored events. */
  readonly model: string;
  classify(envelope: FeatureEnvelope, opts: ClassifyOptions): Promise<Verdict>;
}

export type LlmErrorKind = 'timeout' | 'http' | 'invalid_output' | 'config';

export class LlmError extends Error {
  constructor(
    public readonly kind: LlmErrorKind,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

/** Providers return prose around JSON often enough that a tolerant extractor is worth it. */
export function parseVerdict(raw: string): Verdict {
  const trimmed = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/, '');
  const candidates = [trimmed];
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first !== -1 && last > first)
    candidates.push(trimmed.slice(first, last + 1));

  for (const candidate of candidates) {
    try {
      const parsed = verdictSchema.safeParse(JSON.parse(candidate));
      if (parsed.success) return parsed.data;
    } catch {
      /* try the next candidate */
    }
  }
  throw new LlmError(
    'invalid_output',
    `Provider did not return a valid verdict: ${trimmed.slice(0, 160)}`,
  );
}
