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

export const CONFIDENCE_LEVELS = ['low', 'medium', 'high'] as const;
export type Confidence = (typeof CONFIDENCE_LEVELS)[number];

/**
 * Model judgement mapped to the number the gateway acts on.
 *
 * Measured on qwen2.5:7b (docs/results/anomaly-eval.md): asked for a score, the model reproduces the
 * heuristic score it was shown to within 0.02, and hidden that field it emits a generic 0.45-0.55.
 * It was never once wrong about the *category*, across fourteen classifications. So the model is
 * asked for a verdict and a confidence, and the score is derived here.
 *
 * The numbers are chosen against the thresholds they have to clear: gate 0.4, flag 0.7, block 0.9.
 * A confidently suspicious request must be able to reach the flag line, which it could not before,
 * because the prompt's own "suspicious" band stopped at exactly the threshold that triggers action.
 * A benign verdict scores *lower* as confidence rises, since confidence is in the verdict, not in
 * how dangerous the request is.
 */
export const CONFIDENCE_SCORE: Record<
  'benign' | 'suspicious' | 'malicious',
  Record<Confidence, number>
> = {
  benign: { low: 0.15, medium: 0.08, high: 0.02 },
  suspicious: { low: 0.45, medium: 0.65, high: 0.8 },
  malicious: { low: 0.75, medium: 0.92, high: 0.97 },
};

/** Structured output contract. Everything a provider returns is validated against this before use (T14). */
export const verdictSchema = z.object({
  /**
   * A model may still volunteer a number. It is validated, kept as `rawScore` for diagnostics, and
   * never acted on: the `score` the rest of the gateway reads is derived from verdict and
   * confidence below. Out of range still rejects the whole verdict, because a provider that returns
   * score 4 is not returning output we should trust the rest of.
   */
  score: z.coerce.number().min(0).max(1).optional(),
  confidence: z.enum(CONFIDENCE_LEVELS).default('medium'),
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
})
  // Spread conditionally so `rawScore` stays optional on the output type: most callers build a
  // verdict by hand and should not have to supply a field that only a provider fills in.
  .transform(({ score, ...v }) => ({
    ...v,
    ...(score === undefined ? {} : { rawScore: score }),
    score: CONFIDENCE_SCORE[v.verdict][v.confidence],
  }));

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
