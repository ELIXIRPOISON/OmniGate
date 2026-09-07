// k6 scenario for docs/08 S3-05 and docs/09 §4: 500 rps for 60 s spread over N principals whose
// policy allows MAX requests per window. Expect zero 5xx, 429s within ±2 % of the arithmetic,
// and p95 under 25 ms for accepted requests.
//
//   docker run --rm -i --add-host=host.docker.internal:host-gateway \
//     -v "$PWD/load:/scripts" -v "$PWD/docs/results:/results" \
//     -e BASE_URL=http://host.docker.internal:8080 -e JWT_SECRET="$JWT_SECRET" \
//     -e SUMMARY_PATH=/results/ratelimit-k6.txt grafana/k6 run /scripts/ratelimit.js
//
// Principals are JWT subjects minted here with JWT_SECRET (HS256), so no database setup is needed.
import http from 'k6/http';
import { check } from 'k6';
import crypto from 'k6/crypto';
import encoding from 'k6/encoding';
import { Counter } from 'k6/metrics';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.1.0/index.js';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';
const ROUTE = __ENV.ROUTE || '/api/orders/items';
const RATE = Number(__ENV.RATE || 500);
const DURATION_S = Number(__ENV.DURATION_S || 60);
const PRINCIPALS = Number(__ENV.PRINCIPALS || 20);
const MAX_REQUESTS = Number(__ENV.MAX_REQUESTS || 100);
const SUMMARY_PATH = __ENV.SUMMARY_PATH || 'docs/results/ratelimit-k6.txt';
const SUBJECT_PREFIX = __ENV.SUBJECT_PREFIX || 'load';

const total = RATE * DURATION_S;
const expected429 = total - PRINCIPALS * MAX_REQUESTS;
const tolerance = Math.ceil(total * 0.02);

const status2xx = new Counter('status_2xx');
const status429 = new Counter('status_429');
const status5xx = new Counter('status_5xx');
const statusOther = new Counter('status_other');
const degraded = new Counter('degraded_responses');

export const options = {
  scenarios: {
    steady: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: `${DURATION_S}s`,
      preAllocatedVUs: 100,
      maxVUs: 500,
    },
  },
  thresholds: {
    status_5xx: ['count==0'],
    status_429: [`count>=${expected429 - tolerance}`, `count<=${expected429 + tolerance}`],
    'http_req_duration{expected_response:true}': ['p(95)<25'],
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
  const payload = b64url(JSON.stringify({ sub, scope: 'orders:read', iat: now, exp: now + 3600 }));
  const signature = crypto.hmac('sha256', __ENV.JWT_SECRET, `${header}.${payload}`, 'base64rawurl');
  return `${header}.${payload}.${signature}`;
}

export function setup() {
  const tokens = [];
  for (let i = 0; i < PRINCIPALS; i++) tokens.push(mint(`${SUBJECT_PREFIX}-${i}`));
  const probe = http.get(`${BASE_URL}/readyz`);
  if (probe.status !== 200) throw new Error(`gateway not ready at ${BASE_URL}: ${probe.status} ${probe.body}`);
  return { tokens };
}

export default function (data) {
  const token = data.tokens[Math.floor(Math.random() * PRINCIPALS)];
  const res = http.get(`${BASE_URL}${ROUTE}`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status >= 200 && res.status < 300) status2xx.add(1);
  else if (res.status === 429) status429.add(1);
  else if (res.status >= 500) status5xx.add(1);
  else statusOther.add(1);
  if (res.headers['X-Ratelimit-Degraded']) degraded.add(1);

  check(res, {
    'status is 2xx or 429': (r) => (r.status >= 200 && r.status < 300) || r.status === 429,
    'has X-Request-Id': (r) => !!r.headers['X-Request-Id'],
    'rate-limit headers present': (r) => !!r.headers['X-Ratelimit-Limit'] || !!r.headers['X-Ratelimit-Degraded'],
    '429 carries Retry-After': (r) => r.status !== 429 || Number(r.headers['Retry-After']) >= 1,
  });
}

// k6 marks 429 as failed by default; treat 2xx and 429 as expected so only real errors count as failures
// and the latency threshold covers the requests the gateway actually served.
http.setResponseCallback(http.expectedStatuses({ min: 200, max: 299 }, 429));

export function handleSummary(data) {
  const header = [
    `OmniGate rate-limit load test - ${new Date().toISOString()}`,
    `target ${BASE_URL}${ROUTE} | ${RATE} rps x ${DURATION_S}s | ${PRINCIPALS} principals x ${MAX_REQUESTS} req/window`,
    `expected 429s: ${expected429} (±${tolerance})`,
    '',
  ].join('\n');
  const text = header + textSummary(data, { indent: ' ', enableColors: false });
  return { stdout: text, [SUMMARY_PATH]: text };
}
