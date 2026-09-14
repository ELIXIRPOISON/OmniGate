import type { Verdict } from './llm/provider.js';

/**
 * How the model's judgement combines with the heuristic score.
 *
 * The gateway used to take the model's number outright, which made the second stage capable of
 * *lowering* a confident heuristic finding by accident. Measured on qwen2.5:7b, that is not
 * hypothetical: withhold the heuristic score from the envelope and the model answers
 * "suspicious / medium" to 17 of 21 sampled rows, SQL injection included, which would have dropped
 * recall from 0.900 to 0.433. A weak or badly configured model must never make detection worse than
 * no model at all.
 *
 * So the second stage escalates by default and de-escalates only when it says so explicitly:
 *
 * - any verdict may raise the score, never lower it;
 * - `benign` at high confidence may lower it, because that is the case the model exists to catch:
 *   the named partner key doing a bulk sync that every behavioural signal reads as scraping.
 *
 * A side effect worth stating: this makes anchoring harmless. The model reproducing the heuristic
 * score is now a no-op rather than a silent overwrite, so showing it the signals costs nothing and
 * genuine disagreement upward is still a win.
 */
export function combineScores(
  heuristicScore: number,
  verdict: Pick<Verdict, 'score' | 'verdict' | 'confidence'> | null | undefined,
): number {
  if (!verdict) return heuristicScore;
  if (verdict.verdict === 'benign' && verdict.confidence === 'high')
    return Math.min(heuristicScore, verdict.score);
  return Math.max(heuristicScore, verdict.score);
}
