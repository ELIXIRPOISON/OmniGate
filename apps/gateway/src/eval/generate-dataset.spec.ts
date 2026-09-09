import { generateDataset, summarize } from './generate-dataset.js';

describe('eval dataset generator (docs/06 §8.1)', () => {
  const rows = generateDataset();

  it('produces 200 rows with the documented class mix, deterministically', () => {
    expect(rows).toHaveLength(200);
    expect(rows.filter((r) => r.label === 'benign')).toHaveLength(80);
    expect(rows.filter((r) => r.label === 'malicious')).toHaveLength(120);
    expect(generateDataset().map((r) => r.envelope.heuristics.score)).toEqual(
      rows.map((r) => r.envelope.heuristics.score),
    );
    expect(new Set(rows.map((r) => r.id)).size).toBe(200);
  });

  it('redacts samples: no email or password value survives', () => {
    const text = rows
      .map((r) => r.envelope.bodySample + r.envelope.querySample)
      .join('\n');
    expect(text).not.toMatch(/@example\.com/);
    expect(text).not.toMatch(/Password\d+!/);
  });

  it('heuristics alone already separate the classes reasonably (LLM stage raises this in Sprint 6)', () => {
    const s = summarize(rows, 0.7);
    expect(s.precision).toBeGreaterThanOrEqual(0.8);
    expect(s.recall).toBeGreaterThanOrEqual(0.6);
  });
});
