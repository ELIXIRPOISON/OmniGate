# OmniGate - AI-powered API Gateway

> A self-hosted gateway that fronts your microservices with JWT/API-key auth, Redis-backed rate limiting and caching, LLM-assisted anomaly detection, and a real-time React dashboard.

**Status:** Sprint 5 of 9 (kickoff 7 Sep 2026, v1.0 target 6 Nov 2026). Phases 1 and 2 done (routing, proxying, auth, readiness, rate limiting, cache); Phase 3 in progress: heuristic anomaly pre-screen and async queue live, LLM classification next. Nothing is deployed yet.
**Stack:** NestJS 12 (Express) · Redis 7 · PostgreSQL 16 + Prisma · BullMQ · React 19 + Vite · TypeScript 6 · Docker

## Request lifecycle

`X-Request-Id` → route resolve → auth (JWT | API key) → rate limit (Redis Lua sliding window) → cache (GET) → heuristic anomaly score → proxy → async audit log.
LLM classification runs off the hot path by default; routes can opt into synchronous blocking with an 800 ms fail-open timeout.

Full design: [`docs/02-ARCHITECTURE.md`](docs/02-ARCHITECTURE.md). Start with [`docs/00-INDEX.md`](docs/00-INDEX.md).

## Project structure

```
apps/gateway        NestJS gateway + worker (data plane, admin API)
apps/dashboard      React admin UI
apps/mock-upstream  Tiny Express service the demo and tests proxy to
load/               k6 scenarios
docs/eval/          200-row labelled anomaly evaluation set (generated)
packages/shared     DTO / contract types shared by both apps
docs/               PRD, architecture + ADRs, specs, delivery plan, journal
```

## Quick start (docker compose)

```bash
cp .env.example .env
docker compose up --build -d                 # gateway :8080, mock upstream :3001, redis, postgres
docker compose exec gateway pnpm seed        # creates admin, policies, routes and prints a demo API key ONCE
export KEY=gw_live_...                       # paste the key from the seed output

curl -i localhost:8080/api/mock/items                      # open route: proxied, X-Request-Id on the response
curl -i localhost:8080/api/orders/items                    # protected route without credentials -> 401 problem+json
curl -i -H "X-API-Key: $KEY" localhost:8080/api/orders/items    # API key -> 200, upstream sees X-Gateway-Principal
curl -i localhost:8080/api/nope                            # unknown service -> 404 problem+json
curl -s localhost:8080/readyz                              # {"status":"ok","redis":"ok","postgres":"ok","routes":2}
```

JWT flow (HS256 with `JWT_SECRET` from `.env`):

```bash
TOKEN=$(docker compose exec gateway pnpm --silent mint-jwt -- --sub alice --scope "orders:read")
curl -i -H "Authorization: Bearer $TOKEN" localhost:8080/api/orders/items     # 200, principal user:alice
TOKEN=$(docker compose exec gateway pnpm --silent mint-jwt -- --sub bob --scope "other")
curl -i -H "Authorization: Bearer $TOKEN" localhost:8080/api/orders/items     # 403 insufficient_scope
```

Rate limiting is visible on every response:

```bash
for i in $(seq 1 31); do curl -s -o /dev/null -w "%{http_code} " localhost:8080/api/mock/items; done; echo   # 30 x 200 then 429
curl -si localhost:8080/api/mock/items | grep -iE '^HTTP|x-ratelimit|retry-after'
```

The response cache is visible on GET/HEAD responses of routes with a `cache_ttl_seconds` (`X-Cache: HIT|MISS|BYPASS`, `Age`):

```bash
TOKEN=$(docker compose exec gateway pnpm --silent mint-jwt -- --sub demo --scope catalog:read)
curl -si -H "Authorization: Bearer $TOKEN" 'localhost:8080/api/catalog/items?page=1' | grep -iE 'x-cache|^age'   # MISS
curl -si -H "Authorization: Bearer $TOKEN" 'localhost:8080/api/catalog/items?page=1' | grep -iE 'x-cache|^age'   # HIT, Age: n
curl -si -H "Authorization: Bearer $TOKEN" -H 'Cache-Control: no-cache' 'localhost:8080/api/catalog/items?page=1' | grep -i x-cache   # BYPASS (refreshes)
ADMIN=$(grep ^ADMIN_TOKEN= .env | cut -d= -f2-)
curl -s -X POST -H "Authorization: Bearer $ADMIN" localhost:8080/admin/v1/routes/catalog/cache/purge        # {"routeId":"catalog","deletedKeys":n}
```

Every request is scored inline by eight heuristics (sub-millisecond) and suspicious ones are queued for the LLM stage. In development the score is exposed as a header:

```bash
curl -si "localhost:8080/api/mock/items?id=1'%20OR%201=1--" | grep -i x-anomaly    # X-Anomaly-Score: 0.901, injection_patterns=1.00, queued: gate
curl -si "localhost:8080/api/mock/items?page=2" | grep -i x-anomaly              # X-Anomaly-Score: 0.01x
docker compose exec redis redis-cli --scan --pattern 'bull:anomaly:*'            # the queued jobs
```

Suspicious requests are then classified off the hot path by a pluggable model backend. A route can opt
into synchronous screening, where the verdict is awaited briefly and a high score is refused:

```bash
curl -si -H "X-API-Key: $KEY" "localhost:8080/api/orders/items?id=1'%20OR%201=1--"   # 403 problem+json
```

### Choosing a model backend

`LLM_PROVIDER` selects the adapter. The default, `fake`, is a deterministic stub that needs no account,
no network and no cost.

| `LLM_PROVIDER` | Backend | Notes |
|---|---|---|
| `fake` | none | Deterministic rule stub for tests, CI and offline development |
| `local` | Any OpenAI-compatible server you run | Defaults to Ollama on `http://localhost:11434/v1`; nothing leaves your machine |
| `openai` | OpenAI, or any compatible endpoint | Set `LLM_BASE_URL` for Groq, Together, Mistral, DeepSeek or vLLM |
| `anthropic` | Anthropic Messages API | Forced tool call for structured output |

Only the redacted feature envelope is ever sent: masked query and body samples, heuristic signals and
short-term sender statistics. Any backend can be scored against the labelled dataset:

```bash
pnpm --filter @omnigate/gateway eval:anomaly -- --provider fake
pnpm --filter @omnigate/gateway eval:anomaly -- --provider local --model qwen2.5:7b
```

Results and the threshold sweep live in [`docs/results/anomaly-eval.md`](docs/results/anomaly-eval.md).

Load and chaos scenarios (k6 via Docker, results committed under `docs/results/`):

```bash
export JWT_SECRET=$(grep ^JWT_SECRET= .env | cut -d= -f2-)
docker run --rm -i --add-host=host.docker.internal:host-gateway -v "$PWD/load:/scripts:ro" -v "$PWD/docs/results:/results" \
  -e BASE_URL=http://host.docker.internal:8080 -e JWT_SECRET -e SUMMARY_PATH=/results/ratelimit-k6.txt \
  grafana/k6 run /scripts/ratelimit.js                       # 500 rps x 60 s: 0 x 5xx, 429s within ±2 %, p95 < 25 ms
docker run --rm -i --add-host=host.docker.internal:host-gateway -v "$PWD/load:/scripts:ro" -v "$PWD/docs/results:/results" \
  -e BASE_URL=http://host.docker.internal:8080 -e JWT_SECRET -e SUMMARY_PATH=/results/cache-k6.txt \
  grafana/k6 run /scripts/cache.js                           # 300 rps x 90 s read-heavy: hit ratio >= 60 %, p95 HIT < 5 ms
```

If 6379 or 5432 are already used on your machine, set `REDIS_HOST_PORT` / `POSTGRES_HOST_PORT` in `.env`.
After changing dependencies run `docker compose build && docker compose up -V`.

## Development

Requires Node 22 (`.nvmrc`), pnpm 10, and Docker.

```bash
cp .env.example .env
pnpm install
pnpm build            # builds shared first, then the apps
pnpm typecheck
pnpm lint
pnpm test                                  # unit tests (no Docker needed)
pnpm test:e2e                              # proxy behaviour against an in-process upstream, no data stores
pnpm test:integration                      # auth + readiness against real Redis/Postgres via Testcontainers (Docker)
docker compose up -d postgres redis        # data stores only, for running the gateway on the host
pnpm --filter @omnigate/gateway prisma:migrate:dev   # create/apply migrations while iterating on the schema
pnpm --filter @omnigate/mock-upstream start:dev   # http://localhost:3001
pnpm dev:gateway                           # http://localhost:8080 (reads .env from the repo root)
pnpm dev:dashboard                         # http://localhost:5173
```

Route table: `apps/gateway/routes.yaml` (schema in [`docs/03-API-SPEC.md`](docs/03-API-SPEC.md)). Every variable the gateway reads is validated at boot; a missing or malformed one prints a readable list and exits. The Prisma client is generated into `apps/gateway/src/generated` (git-ignored) by `pnpm gen`, which every root script runs first.

The day-by-day plan lives in [`docs/08-DELIVERY-PLAN.md`](docs/08-DELIVERY-PLAN.md); the daily journal in [`docs/journal.md`](docs/journal.md).

## License

MIT
