import type { FeatureEnvelope } from '../envelope.js';
import type { ClassifyOptions, LlmProvider, Verdict } from './provider.js';

/**
 * Deterministic stand-in used by tests, CI and any run without model access (LLM_PROVIDER=fake).
 * It is NOT a model: it applies a small rule set over the already-redacted envelope, weighting the
 * behavioural statistics that the inline heuristics deliberately keep cheap. Useful to exercise the
 * whole pipeline end to end; the numbers it produces must never be reported as model quality.
 */
export class FakeProvider implements LlmProvider {
  readonly name = 'fake';
  readonly model = 'fake-rules-v1';

  constructor(private readonly delayMs = 0) {}

  async classify(
    envelope: FeatureEnvelope,
    _opts: ClassifyOptions,
  ): Promise<Verdict> {
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));

    const categories = new Set<string>(envelope.heuristics.categories);
    const stats = envelope.principalStats10m;
    const ua = (envelope.userAgent ?? '').toLowerCase();
    let score = envelope.heuristics.score;
    const reasons: string[] = [];

    if (envelope.heuristics.matchedPatterns.length > 0) {
      score = Math.max(score, 0.9);
      reasons.push(
        `injection signature ${envelope.heuristics.matchedPatterns[0]}`,
      );
    }
    // Behavioural evidence the inline pass only sees a slice of.
    if (stats.distinctPaths > 500 && stats.requests > 500) {
      score = Math.max(score, 0.75);
      categories.add('scraping').add('enumeration');
      reasons.push(`${stats.distinctPaths} distinct paths in 10 min`);
    }
    if (stats.errorRate > 0.8 && stats.requests > 100) {
      score = Math.max(score, 0.8);
      categories.add('credential_stuffing');
      reasons.push(
        `${Math.round(stats.errorRate * 100)}% errors over ${stats.requests} requests`,
      );
    }
    if (
      /sqlmap|nikto|nuclei|gobuster|masscan|ffuf|dirbuster|havij|nmap|zgrab/.test(
        ua,
      )
    ) {
      score = Math.max(score, 0.85);
      categories.add('enumeration');
      reasons.push('scanner user agent');
    }
    // A single trusted integration hitting one path fast is normal traffic, not abuse.
    if (
      score < 0.7 &&
      stats.distinctPaths <= 5 &&
      envelope.principal.startsWith('api_key:')
    ) {
      score = Math.min(score, 0.25);
      reasons.push('trusted integration on few paths');
    }

    score = Math.round(Math.min(1, Math.max(0, score)) * 1000) / 1000;
    return {
      score,
      verdict:
        score >= 0.7 ? 'malicious' : score >= 0.3 ? 'suspicious' : 'benign',
      categories: [...categories].filter((c) =>
        [
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
        ].includes(c),
      ) as Verdict['categories'],
      reasoning: (reasons.length
        ? reasons.join('; ')
        : 'No attack indicators in the redacted sample or sender statistics.'
      ).slice(0, 240),
    };
  }
}
