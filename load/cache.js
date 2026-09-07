// k6 scenario for docs/08 S4-05 and docs/09 §4: 300 rps read-heavy mix (90 % GET over 20 hot paths,
// 10 % POST) against a cached route. Expect hit ratio >= 60 %, p95 of HIT responses < 5 ms, zero 5xx.
//
//   docker run --rm -i --add-host=host.docker.internal:host-gateway \
//     -v "$PWD/load:/scripts:ro" -v "$PWD/docs/results:/results" \
//     -e BASE_URL=http://host.docker.internal:8080 -e JWT_SECRET="$JWT_SECRET" \
//     -e SUMMARY_PATH=/results/cache-k6.txt grafana/k6 run /scripts/cache.js
import http from 'k6/http';
import { check } from 'k6';
import crypto from 'k6/crypto';
import encoding from 'k6/encoding';
import { Counter, Rate, Trend } from 'k6/metrics';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.1.0/index.js';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';
const ROUTE = __ENV.ROUTE || '/api/catalog';
const RATE = Number(__ENV.RATE || 300);
const DURATION_S = Number(__ENV.DURATION_S || 90);
const PRINCIPALS = Number(__ENV.PRINCIPALS || 20);
const HOT_PATHS = Number(__ENV.HOT_PATHS || 20);
const WRITE_SHARE = Number(__ENV.WRITE_SHARE || 0.1);
const SUMMARY_PATH = __ENV.SUMMARY_PATH || 'docs/results/cache-k6.txt';

const hitRatio = new Rate('cache_hit_ratio');
const hitDuration = new Trend('cache_hit_duration', true);
const missDuration = new Trend('cache_miss_duration', true);
const status2xx = new Counter('status_2xx');
const status429 = new Counter('status_429');
const status5xx = new Counter('status_5xx');
const statusOther = new Counter('status_other');

export const options = {
  scenarios: {
    mixed: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: `${DURATION_S}s`,
      preAllocatedVUs: 60,
      maxVUs: 300,
    },
  },
  thresholds: {
    cache_hit_ratio: ['rate>=0.6'],
    cache_hit_duration: ['p(95)<5'],
    status_5xx: ['count==0'],
    status_429: ['count==0'],
    checks: ['rate>0.99'],
  },
};

function b64url(input) {
  return encoding.b64encode(input, 'rawurl');
}

function mint(sub) {
  if (!__ENV.JWT_SECRET) throw new Error('JWT_SECRET is required to mint load-test tokens');
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(JSON.stringify({ sub, scope: 'catalog:read', iat: now, exp: now + 3600 }));
  const signature = crypto.hmac('sha256', __ENV.JWT_SECRET, `${header}.${payload}`, 'base64rawurl');
  return `${header}.${payload}.${signature}`;
}

export function setup() {
  const tokens = [];
  for (let i = 0; i < PRINCIPALS; i++) tokens.push(mint(`cache-${i}`));
  const probe = http.get(`${BASE_URL}/readyz`);
  if (probe.status !== 200) throw new Error(`gateway not ready at ${BASE_URL}: ${probe.status} ${probe.body}`);
  return { tokens };
}

export default function (data) {
  const token = data.tokens[Math.floor(Math.random() * PRINCIPALS)];
  const headers = { Authorization: `Bearer ${token}` };
  const isWrite = Math.random() < WRITE_SHARE;

  let res;
  if (isWrite) {
    res = http.post(`${BASE_URL}${ROUTE}/items`, JSON.stringify({ name: `load-${__VU}-${__ITER}` }), {
      headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
    });
  } else {
    const hot = Math.floor(Math.random() * HOT_PATHS);
    res = http.get(`${BASE_URL}${ROUTE}/items?page=${hot}`, { headers });
    const xc = res.headers['X-Cache'];
    if (xc === 'HIT') {
      hitRatio.add(1);
      hitDuration.add(res.timings.duration);
    } else if (xc === 'MISS' || xc === 'BYPASS') {
      hitRatio.add(0);
      missDuration.add(res.timings.duration);
    }
  }

  if (res.status >= 200 && res.status < 300) status2xx.add(1);
  else if (res.status === 429) status429.add(1);
  else if (res.status >= 500) status5xx.add(1);
  else statusOther.add(1);

  check(res, {
    'status is 2xx': (r) => r.status >= 200 && r.status < 300,
    'GET carries X-Cache': (r) => isWrite || r.headers['X-Cache'] !== undefined,
    'POST is never cached': (r) => !isWrite || r.headers['X-Cache'] === undefined,
  });
}

export function handleSummary(data) {
  const header = [
    `OmniGate response-cache load test - ${new Date().toISOString()}`,
    `target ${BASE_URL}${ROUTE} | ${RATE} rps x ${DURATION_S}s | ${Math.round((1 - WRITE_SHARE) * 100)} % GET over ${HOT_PATHS} hot paths, ${Math.round(WRITE_SHARE * 100)} % POST | ${PRINCIPALS} principals`,
    'thresholds: cache_hit_ratio >= 0.6, p95(cache_hit_duration) < 5 ms, no 5xx, no 429',
    '',
  ].join('\n');
  const text = header + textSummary(data, { indent: ' ', enableColors: false });
  return { stdout: text, [SUMMARY_PATH]: text };
}
