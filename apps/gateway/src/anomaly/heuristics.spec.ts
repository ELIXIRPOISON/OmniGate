import {
  authFailuresSignal,
  bodySizeSignal,
  burstSignal,
  entropySignal,
  type HeuristicInput,
  injectionSignal,
  methodMismatchSignal,
  noisyOr,
  pathEnumSignal,
  scoreHeuristics,
  shannonEntropy,
  userAgentSignal,
} from './heuristics.js';

const quiet: HeuristicInput['stats'] = {
  burstCount10s: 1,
  policyMax: 100,
  distinctPaths60s: 2,
  authFailures60s: 0,
  routeBody: null,
};
const base = (over: Partial<HeuristicInput> = {}): HeuristicInput => ({
  method: 'GET',
  path: '/v1/orders',
  query: '?page=2',
  bodyText: null,
  bodyBytes: 0,
  userAgent:
    'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/128 Safari/537.36',
  routeMethods: ['*'],
  stats: quiet,
  ...over,
});

describe('injection_patterns', () => {
  it.each([
    ['sqli tautology', { query: "?id=1' OR 1=1--" }, 'sqli'],
    ['sqli url-encoded', { query: '?id=1%27%20OR%20%271%27%3D%271' }, 'sqli'],
    [
      'sqli union',
      { query: '?q=1 UNION ALL SELECT username,password FROM users' },
      'sqli',
    ],
    [
      'sqli time based',
      { bodyText: '{"q":"1; SELECT pg_sleep(5)--"}' },
      'sqli',
    ],
    [
      'xss script',
      { bodyText: '{"comment":"<script>alert(1)</script>"}' },
      'xss',
    ],
    ['xss handler', { query: '?name=<img src=x onerror=alert(1)>' }, 'xss'],
    ['traversal', { path: '/files/../../../../etc/passwd' }, 'traversal'],
    [
      'traversal encoded',
      { path: '/files/%2e%2e%2f%2e%2e%2fetc%2fshadow' },
      'traversal',
    ],
    [
      'cmd injection',
      { query: '?host=8.8.8.8; cat /etc/passwd' },
      'cmd_injection',
    ],
    ['cmd subshell', { bodyText: '{"name":"$(whoami)"}' }, 'cmd_injection'],
    ['ssti', { query: '?name={{7*7}}' }, 'ssti'],
  ] as const)('flags %s', (_label, over, category) => {
    const r = injectionSignal(base(over as Partial<HeuristicInput>));
    expect(r.score).toBe(1);
    expect(r.categories).toContain(category);
  });

  it.each([
    ['plain search', { query: '?q=blue shoes size 42' }],
    [
      'apostrophe in name',
      { bodyText: '{"name":"O\'Brien","city":"Coeur d\'Alene"}' },
    ],
    [
      'select as a word',
      { bodyText: '{"text":"please select all that apply and union them"}' },
    ],
    ['math-ish query', { query: '?expr=1+1=2&note=and then' }],
    ['dotted path', { path: '/v1/files/report.v2.final.pdf' }],
    [
      'markdown',
      {
        bodyText:
          '{"md":"# Title\\nSome **bold** text, see http://example.com/a?b=c"}',
      },
    ],
  ] as const)('does not flag %s', (_label, over) => {
    expect(injectionSignal(base(over as Partial<HeuristicInput>)).score).toBe(
      0,
    );
  });
});

describe('individual signals', () => {
  it('body_size_z ramps with the z-score and needs enough samples', () => {
    expect(bodySizeSignal(50_000, { n: 5, mean: 500, std: 100 })).toBe(0);
    expect(bodySizeSignal(600, { n: 100, mean: 500, std: 100 })).toBe(0);
    expect(bodySizeSignal(900, { n: 100, mean: 500, std: 100 })).toBeCloseTo(
      0.5,
      5,
    );
    expect(bodySizeSignal(50_000, { n: 100, mean: 500, std: 100 })).toBe(1);
    expect(bodySizeSignal(0, { n: 100, mean: 500, std: 100 })).toBe(0);
  });

  it('entropy flags encoded blobs and ignores prose or short bodies', () => {
    const blob = Buffer.from(
      Array.from({ length: 300 }, (_, i) => (i * 7919) % 256),
    ).toString('base64');
    expect(shannonEntropy('aaaa')).toBe(0);
    expect(entropySignal(blob)).toBeGreaterThan(0.9);
    expect(
      entropySignal(
        JSON.stringify({
          text: 'the quick brown fox jumps over the lazy dog and keeps running through the field'.repeat(
            3,
          ),
        }),
      ),
    ).toBe(0);
    expect(entropySignal('short')).toBe(0);
  });

  it('burst is the 10 s count over the policy max', () => {
    expect(burstSignal(5, 100)).toBe(0.05);
    expect(burstSignal(150, 100)).toBe(1);
    expect(burstSignal(5, 0)).toBe(0);
  });

  it('path_enum, auth_failures ramp to 1 at the documented thresholds', () => {
    expect(pathEnumSignal(10)).toBe(0);
    expect(pathEnumSignal(35)).toBeCloseTo(0.5, 5);
    expect(pathEnumSignal(80)).toBe(1);
    expect(authFailuresSignal(2)).toBe(0);
    expect(authFailuresSignal(10)).toBe(1);
  });

  it('ua_anomaly: scanners 1, missing 0.6, browsers 0', () => {
    expect(userAgentSignal('sqlmap/1.7#stable (https://sqlmap.org)')).toBe(1);
    expect(userAgentSignal('Mozilla/5.0 Nikto/2.1.6')).toBe(1);
    expect(userAgentSignal(undefined)).toBe(0.6);
    expect(userAgentSignal('')).toBe(0.6);
    expect(userAgentSignal('Mozilla/5.0 (X11; Linux) Firefox/130.0')).toBe(0);
    expect(userAgentSignal('python-requests/2.32')).toBe(0);
  });

  it('method_mismatch respects the wildcard', () => {
    expect(methodMismatchSignal('DELETE', ['GET', 'POST'])).toBe(1);
    expect(methodMismatchSignal('post', ['GET', 'POST'])).toBe(0);
    expect(methodMismatchSignal('DELETE', ['*'])).toBe(0);
  });
});

describe('noisyOr + scoreHeuristics', () => {
  it('lets one strong signal dominate and weak signals add up', () => {
    const none = {
      injection_patterns: 0,
      body_size_z: 0,
      entropy: 0,
      burst: 0,
      path_enum: 0,
      ua_anomaly: 0,
      auth_failures: 0,
      method_mismatch: 0,
    };
    expect(noisyOr(none)).toBe(0);
    expect(noisyOr({ ...none, injection_patterns: 1 })).toBe(0.9);
    const weak = noisyOr({
      ...none,
      burst: 0.5,
      path_enum: 0.5,
      ua_anomaly: 0.6,
    });
    expect(weak).toBeGreaterThan(0.5);
    expect(weak).toBeLessThan(0.9);
  });

  it('scores a normal call near 0 and an injection attempt high (sprint exit demo)', () => {
    expect(scoreHeuristics(base()).score).toBeLessThan(0.05);
    const attack = scoreHeuristics(
      base({ query: "?id=1' OR 1=1--", userAgent: 'sqlmap/1.7' }),
    );
    expect(attack.score).toBeGreaterThan(0.9);
    expect(attack.categories).toEqual(
      expect.arrayContaining(['sqli', 'enumeration']),
    );
    expect(attack.matchedPatterns).toContain('tautology');
  });

  it('derives behavioural categories from the stats-based signals', () => {
    const scraper = scoreHeuristics(
      base({ stats: { ...quiet, burstCount10s: 120, distinctPaths60s: 70 } }),
    );
    expect(scraper.categories).toEqual(
      expect.arrayContaining(['enumeration', 'scraping']),
    );
    const stuffer = scoreHeuristics(
      base({
        method: 'POST',
        path: '/login',
        stats: { ...quiet, authFailures60s: 25 },
      }),
    );
    expect(stuffer.categories).toContain('credential_stuffing');
    expect(stuffer.score).toBeGreaterThanOrEqual(0.7);
  });
});

describe('micro-benchmark (docs/08 S5-02: p99 < 0.5 ms)', () => {
  it('scores 10,000 synthetic requests fast enough', () => {
    const inputs: HeuristicInput[] = Array.from({ length: 10_000 }, (_, i) =>
      base({
        method: i % 7 === 0 ? 'POST' : 'GET',
        path: `/v1/items/${i % 250}`,
        query:
          i % 11 === 0
            ? `?id=${i}' OR 1=1--`
            : `?page=${i % 9}&sort=name&q=blue%20shoes`,
        bodyText:
          i % 7 === 0
            ? JSON.stringify({
                name: `item-${i}`,
                tags: ['a', 'b'],
                note: 'x'.repeat(i % 300),
              })
            : null,
        bodyBytes: i % 7 === 0 ? 120 + (i % 300) : 0,
        stats: {
          ...quiet,
          burstCount10s: i % 40,
          distinctPaths60s: i % 60,
          routeBody: { n: 500, mean: 200, std: 80 },
        },
      }),
    );
    for (let i = 0; i < 500; i++) scoreHeuristics(inputs[i]); // warm up
    const samples: number[] = [];
    for (const input of inputs) {
      const t0 = performance.now();
      scoreHeuristics(input);
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    const p99 = samples[Math.floor(samples.length * 0.99)];
    const p50 = samples[Math.floor(samples.length * 0.5)];
    console.log(
      `heuristics micro-benchmark: p50=${p50.toFixed(4)} ms p99=${p99.toFixed(4)} ms`,
    );
    // CI runners are shared and noisy; the local target (0.5 ms) is recorded in docs/06.
    expect(p99).toBeLessThan(process.env.CI ? 2 : 0.5);
  });
});
