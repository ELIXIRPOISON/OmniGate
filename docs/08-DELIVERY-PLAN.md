# 08 · Delivery Plan — Sprints, Backlog, Gates

**Cadence:** 1-week sprints, Mon plan (30 min) → Fri review (30 min). Points are rough effort (1 = ≤2 h, 3 = half day, 5 = full day, 8 = 2 days). Solo capacity ≈ 20–25 pts/week.

## Definition of Ready (a story can start)
- Acceptance criteria written · dependencies done · design section referenced (doc + heading).

## Definition of Done (a story is done)
- Code merged to `main` via PR (self-review checklist) · unit/integration tests added and green in CI · docs updated (README/env table/API spec) · demoable via `docker compose up` · no `TODO` without an issue link.

## Bootstrap (do this first, Sprint 1 Day 1)
```bash
mkdir omnigate && cd omnigate && git init
pnpm init && printf 'packages:\n  - "apps/*"\n  - "packages/*"\n' > pnpm-workspace.yaml
pnpm dlx @nestjs/cli new apps/gateway --package-manager pnpm --strict
pnpm create vite apps/dashboard --template react-ts
mkdir -p packages/shared/src && cd packages/shared && pnpm init && cd ../..
cd apps/gateway && pnpm add http-proxy-middleware ioredis bullmq @prisma/client pino nestjs-pino \
  @nestjs/jwt jose zod yaml bcrypt && pnpm add -D prisma @types/bcrypt supertest testcontainers k6-types
cd ../.. && printf 'node_modules\ndist\n.env\n' > .gitignore
git add . && git commit -m "chore: bootstrap monorepo"
```
Create `.env.example` from the table in `10-DEPLOYMENT-RUNBOOK.md` on day 1 as well.

---

## PHASE 1 · Core Gateway — Sprints 1–2 (7–18 Sep) → **M1 Gateway Alpha**

### Sprint 1 (7–11 Sep) — "Requests flow through"
| ID | Story | Acceptance criteria | Pts |
|----|-------|---------------------|-----|
| S1-01 | Monorepo + CI skeleton | `pnpm -r lint test build` passes; GitHub Actions runs it on PR; Node 22 pinned in `.nvmrc` | 3 |
| S1-02 | Config module | `zod` schema validates all env vars at boot; boot fails fast with a readable message when `REDIS_URL` missing; `routes.yaml` parsed and validated | 3 |
| S1-03 | Request-id middleware + pino logger | Every response has `X-Request-Id`; incoming id is reused if present; one JSON log line per request with method, path, status, latency_ms, request_id | 3 |
| S1-04 | Route resolver | `/api/orders/v1/x` resolves to the `orders` route; unknown service → 404 problem+json; `strip_prefix` honoured | 3 |
| S1-05 | Proxy controller | `http-proxy-middleware` forwards all methods + bodies to upstream; hop-by-hop headers stripped; `X-Forwarded-*` added; upstream down → 502; timeout → 504 | 5 |
| S1-06 | Mock upstream service | `apps/mock-upstream` (tiny Nest/Express app): `GET /items`, `POST /items`, `GET /slow?ms=`, `GET /status/:code`; echoes received headers under `/echo` | 3 |
| S1-07 | Problem-details exception filter | All thrown `HttpException`s and unknown errors render RFC 7807 with `requestId`; 5xx stack traces logged, never returned | 2 |
| S1-08 | docker-compose (dev) | `docker compose up` starts gateway, mock-upstream, redis, postgres; hot reload for gateway | 3 |
**Exit / demo:** `curl localhost:8080/api/mock/items` returns mock data through the gateway with `X-Request-Id`; `curl /api/nope` gives 404 problem+json. **25 pts**

### Sprint 2 (14–18 Sep) — "Only the right people get in"
| ID | Story | Acceptance criteria | Pts |
|----|-------|---------------------|-----|
| S2-01 | Prisma setup + initial migration | Schema from `04` (except audit table) migrated; seed creates admin, 3 policies, 2 routes, 1 demo key | 3 |
| S2-02 | JWT strategy | HS256 via `JWT_SECRET`; RS256 via `JWT_JWKS_URL` (jose, cached JWKS); expired/invalid → 401; `scope` claim parsed | 5 |
| S2-03 | API-key strategy | `X-API-Key` → prefix lookup (Redis read-through, 60 s) → constant-time hash compare → 401 on miss, 403 on revoked/expired; `lastUsedAt` updated at most once/min | 5 |
| S2-04 | AuthGuard + scope check | Route `auth_required` and `scopes` enforced; anon principal = IP for open routes; `X-Gateway-Principal` forwarded | 3 |
| S2-05 | Health endpoints | `/healthz`, `/readyz` per spec; compose healthcheck uses `/readyz` | 2 |
| S2-06 | Integration test harness | Testcontainers (Redis + Postgres) + supertest; tests for 401/403/404/502/504 and happy path; coverage report in CI | 5 |
| S2-07 | Phase-1 docs pass | README quick start works on a clean clone; `03-API-SPEC` matches behaviour | 2 |
**Exit / demo (M1):** All FR-1.x pass; CI green; JWT and API-key flows demoed with curl. **25 pts**

---

## PHASE 2 · Traffic Control — Sprints 3–4 (21 Sep–2 Oct) → **M2 Limits + Cache**

### Sprint 3 (21–25 Sep) — "429 exactly when it should"
| ID | Story | Acceptance criteria | Pts |
|----|-------|---------------------|-----|
| S3-01 | Redis module + Lua loader | ioredis client with reconnect; `defineCommand` for scripts; `readyz` checks PING | 2 |
| S3-02 | Sliding-window Lua script | Script from `05 §1.2`; unit tests via real Redis (testcontainers) for the 4 correctness cases | 5 |
| S3-03 | RateLimitGuard + headers | Policy resolution order (route → key → default); `X-RateLimit-*`, `Retry-After`; `throttle:{principal}` honoured; fail-open with `X-RateLimit-Degraded` | 5 |
| S3-04 | Anonymous per-IP cap | `RL_ANON_MAX` enforced for open routes; trust-proxy aware (`X-Forwarded-For` first hop only when `TRUST_PROXY=true`) | 3 |
| S3-05 | k6 rate-limit scenario | `load/ratelimit.js`: 500 rps for 60 s; assertions: zero 5xx, 429 count within ±2 % of expected | 5 |
| S3-06 | Chaos test | Stop Redis mid-run → no 5xx, degraded header present, recovery after restart | 3 |
**Exit / demo:** k6 report committed to `docs/results/ratelimit-k6.txt`. **23 pts**

### Sprint 4 (28 Sep–2 Oct) — "Fast answers for repeated reads"
| ID | Story | Acceptance criteria | Pts |
|----|-------|---------------------|-----|
| S4-01 | CacheInterceptor | Eligibility rules from `05 §2.1`; HIT/MISS/BYPASS header; `Age` header; body ≤ 256 KB | 5 |
| S4-02 | Cache key + vary on principal | Different principals never share entries when vary is on; sorted query params normalise key | 3 |
| S4-03 | Stampede lock | 50 concurrent MISSes on one key → ≤ 3 upstream calls | 3 |
| S4-04 | Purge + index | `POST /admin/v1/routes/:id/cache/purge` removes all keys for the route (temporary admin auth = static `ADMIN_TOKEN` until Sprint 7) | 3 |
| S4-05 | k6 cache scenario | `load/cache.js` read-heavy mix → hit ratio ≥ 60 %, p95 on HIT < 5 ms | 3 |
| S4-06 | Cache/RL metrics in log line | `cache_status`, `rate_limited`, `upstream_ms` fields added to the request log | 2 |
| S4-07 | Phase-2 docs + ADR-002 update | Real numbers in `05`; env table updated | 2 |
**Exit / demo (M2):** Two k6 reports committed; `X-Cache: HIT` visible in demo. **21 pts**

---

## PHASE 3 · AI Integration — Sprints 5–6 (5–16 Oct) → **M3 Anomaly Guard**

### Sprint 5 (5–9 Oct) — "Score every request, ask the LLM about the odd ones"
| ID | Story | Acceptance criteria | Pts |
|----|-------|---------------------|-----|
| S5-01 | Redactor | All rules in `06 §3`; unit tests with fixtures; never throws (falls back to `[UNPARSEABLE]`) | 3 |
| S5-02 | Heuristic scorer | All 8 signals; noisy-OR combiner; per-signal fixtures; p99 < 0.5 ms measured in a micro-benchmark | 8 |
| S5-03 | Feature envelope + principal stats | Redis-backed 10 m counters (requests, errors, distinct paths via HLL) | 3 |
| S5-04 | BullMQ queue + inline worker | `anomaly` queue; `WORKER_INLINE=true` runs processor in-process; job payload = envelope | 3 |
| S5-05 | Eval dataset v1 | 200-row JSONL per `06 §8.1` committed with a generator script | 5 |
**Exit / demo:** `X-Anomaly-Score` (dev header) shows high score for `' OR 1=1` and ~0 for normal calls; jobs visible in Redis. **22 pts**

### Sprint 6 (12–16 Oct) — "Verdicts, enforcement, and proof it works"
| ID | Story | Acceptance criteria | Pts |
|----|-------|---------------------|-----|
| S6-01 | `LlmProvider` + OpenAI adapter | Structured JSON output validated by zod; retry once; timeout; unit tests with recorded fixtures (no network in CI) | 5 |
| S6-02 | Circuit breaker + daily cap + dedup | Behaviour per `06 §6.3`; tests for open/half-open transitions | 3 |
| S6-03 | Persist `anomaly_events` | Worker writes event; sync path returns verdict to guard | 2 |
| S6-04 | Enforcement modes | `off/async/sync` per route; 403 on sync block; fail-open on timeout; auto-throttle behind flag | 5 |
| S6-05 | Eval harness | `pnpm eval:anomaly` prints precision/recall/F1 for heuristic, LLM, combined; threshold sweep CSV | 5 |
| S6-06 | Tune + results doc | Targets met (P ≥ 0.85, R ≥ 0.80) or gap explained; `docs/results/anomaly-eval.md` with cost estimate | 3 |
**Exit / demo (M3):** Live demo: sqlmap-style request on a sync route → 403 with reasoning in DB; eval results committed. **23 pts**

---

## PHASE 4 · Observability — Sprints 7–8 (19–30 Oct) → **M4 Dashboard**

### Sprint 7 (19–23 Oct) — "Everything lands in Postgres, admin API on top"
| ID | Story | Acceptance criteria | Pts |
|----|-------|---------------------|-----|
| S7-01 | `audit_logs` migration + partitions job | Raw SQL migration from `04 §3`; nightly BullMQ repeatable job creates next partition and drops expired ones | 3 |
| S7-02 | AuditInterceptor + batch writer | In-memory buffer → flush every 1 s or 500 rows → single `unnest` insert; buffer cap 50 k with drop-oldest + warn; zero added p95 latency | 5 |
| S7-03 | Admin auth | `POST /auth/login` (bcrypt), admin JWT guard on `/admin/v1/*`; replaces static token | 3 |
| S7-04 | API keys + routes + policies CRUD | All endpoints in `03 §2` with validation and 409 rules; route changes publish `routes:changed`; registry reloads | 8 |
| S7-05 | Metrics + anomalies + logs endpoints | SQL from `07 §4`; response times < 500 ms for 24 h range on 1 M rows (seeded via script) | 5 |
**Exit / demo:** Postman/Bruno collection committed; curl a full metrics overview. **24 pts**

### Sprint 8 (26–30 Oct) — "See it"
| ID | Story | Acceptance criteria | Pts |
|----|-------|---------------------|-----|
| S8-01 | Dashboard shell | Router, auth flow, layout, time-range picker, TanStack Query with 10 s refresh, `ProblemAlert` | 5 |
| S8-02 | Overview page | 6 KPI cards, 3 charts, spike highlighting, top tables | 5 |
| S8-03 | Anomalies page + drawer | Table, filters, drawer with actions (review labels, throttle) | 5 |
| S8-04 | API keys + Routes pages | CRUD flows incl. one-time key modal, purge, reload | 5 |
| S8-05 | Traffic + Logs pages | Charts and virtualised table | 3 |
| S8-06 | Serve `dist` from gateway + component tests | `/dashboard` served in prod build; Vitest tests for KpiCard, DataTable, OneTimeSecretModal | 2 |
**Exit / demo (M4):** Run k6 in the background, watch the dashboard move; create a key and use it in the same session. **25 pts**

---

## PHASE 5 · Productionizing — Sprint 9 (2–6 Nov) → **M5 v1.0 SHIP**
| ID | Story | Acceptance criteria | Pts |
|----|-------|---------------------|-----|
| S9-01 | Multi-stage Dockerfile | Gateway image < 250 MB, non-root user, `HEALTHCHECK`, builds dashboard in stage 1; `docker compose -f compose.prod.yml up` works | 3 |
| S9-02 | Deploy | Fly.io app + managed Postgres + Redis; `fly deploy` runs `prisma migrate deploy` as release command; public URL responds on `/readyz` and `/dashboard` | 5 |
| S9-03 | Prod hardening | `TRUST_PROXY=true`, HTTPS-only, CORS locked to dashboard origin, helmet headers, body limit, admin password rotated, secrets in Fly secrets | 3 |
| S9-04 | Observability of the gateway itself | `/metrics` Prometheus endpoint (prom-client): request count, latency histogram, rate-limited counter, LLM calls; documented Grafana JSON optional | 3 |
| S9-05 | README + architecture diagram | Template `12` filled; diagram exported as SVG/PNG; demo GIF of dashboard | 3 |
| S9-06 | Release | `CHANGELOG.md`, tag `v1.0.0`, GitHub release with k6 + eval results attached; deploy checklist in `10` completed | 2 |
| S9-07 | Retro + v1.1 backlog | 30-min written retro; open issues for token bucket, custom classifier, rollups, HA notes | 1 |
**Exit (M5):** Public URL live; a stranger can run the quick start in 5 minutes. **20 pts**

---

## Cut lines (if a sprint runs over, drop in this order)
1. S9-04 Prometheus endpoint → v1.1
2. S8-05 Traffic page (fold into Overview filters)
3. S4-03 stampede lock (document as limitation)
4. S6-04 auto-throttle (keep sync/async, drop reactive throttle)
5. S3-06 chaos test (keep the manual check in the runbook)
Never cut: auth, rate limiting, audit logs, README, deployment.

## Risk register
| # | Risk | Likelihood | Impact | Mitigation | Trigger to act |
|---|------|-----------|--------|------------|----------------|
| R1 | LLM latency/cost blows the budget | Med | Med | Async default, gating, cap, dedup (06 §6.3) | Daily cap hit before noon in testing |
| R2 | Heuristics too noisy → dashboard full of false positives | Med | High | Eval set + threshold sweep in S6; tune before enabling auto-throttle | Precision < 0.7 on eval |
| R3 | Audit writes hurt hot-path latency | Low | High | Buffer + batch, measured in S7-02 | p95 overhead > 15 ms |
| R4 | `http-proxy-middleware` body handling with Nest body-parser (double-consumed stream) | High | Med | Disable Nest body parser on `/api/*`, only parse for anomaly screen via `raw-body` with size cap, then re-stream with `fixRequestBody` | Any POST through proxy hangs in S1-05 |
| R5 | Scope creep (multi-tenancy, gRPC…) | High | Med | Non-goals list in PRD; park ideas in `v1.1` milestone | Any story not mapped to an FR |
| R6 | Deploy platform surprises (Redis TLS, private networking) | Med | Med | Do a throwaway `fly deploy` of the Sprint-2 build in week 2 (2 h) | — |
| R7 | Timeline slip | Med | Med | Buffer week 9–13 Nov; cut lines above | Milestone missed by > 3 days |

## Weekly rituals (solo edition)
- **Mon 09:00** pick stories to ≈ 22 pts; write today's 3 tasks.
- **Daily** 5-line journal in `docs/journal.md`: done / blocked / decided.
- **Fri 16:00** run the sprint exit demo, record a 2-min screen capture, tick milestone gates, update risk register.
