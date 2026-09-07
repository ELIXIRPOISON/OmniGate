# 12 · README Template (ship this as the repo's `README.md`)

Replace `{{…}}` placeholders. Keep it under ~250 lines; link to `/docs` for depth.

---

# {{Project Name}} — AI-powered API Gateway

> A self-hosted gateway that fronts your microservices with JWT/API-key auth, Redis-backed rate limiting and caching, LLM-assisted anomaly detection, and a real-time React dashboard.

[![CI](…)](…) · **Live demo:** {{https://…fly.dev/dashboard}} (login: `demo@…` / `{{pw}}`) · **Stack:** NestJS · Redis · PostgreSQL · React · Docker

![dashboard demo](docs/media/dashboard.gif)

## Why
{{2–3 sentences: the problem, why existing gateways didn't fit a side project, what's interesting here (AI layer).}}

## Architecture
![architecture](docs/media/architecture.svg)

**Request lifecycle:** `X-Request-Id` → route resolve → auth (JWT | API key) → rate limit (Redis Lua sliding window) → cache (GET) → heuristic anomaly score → proxy → async audit log.
LLM classification runs off the hot path by default; routes can opt into synchronous blocking with an 800 ms fail-open timeout.

Key decisions (full ADRs in [`docs/02-ARCHITECTURE.md`](docs/02-ARCHITECTURE.md)):
- **NestJS on Express** — guards/interceptors map to gateway concerns; `http-proxy-middleware` underneath.
- **Sliding-window log in Lua** — exact limits, atomic, one round trip.
- **Async LLM by default** — detection quality without paying latency; reactive throttling.
- **Batched audit writes** — buffer → single multi-row insert; partitioned table with BRIN.

## Quick start (5 minutes)
```bash
git clone {{repo}} && cd {{repo}}
cp .env.example .env            # defaults work locally; set LLM_API_KEY or leave LLM_PROVIDER=fake
docker compose up -d
docker compose exec gateway node dist/prisma/seed.js   # prints a demo API key
curl -i -H "X-API-Key: <demo key>" http://localhost:8080/api/mock/items
open http://localhost:5173       # dashboard (admin@example.com / admin)
```
Try it:
```bash
# rate limit
for i in $(seq 1 101); do curl -s -o /dev/null -w "%{http_code}\n" -H "X-API-Key: $KEY" localhost:8080/api/mock/items; done | sort | uniq -c
# cache
curl -sI -H "X-API-Key: $KEY" localhost:8080/api/mock/items | grep -i x-cache
# anomaly (sync route)
curl -i -H "X-API-Key: $KEY" "localhost:8080/api/orders/v1/orders?id=1%27%20OR%201%3D1--"
```

## Features
| Area | What you get |
|------|--------------|
| Routing | `/api/{service}/*` → upstream from `routes.yaml` or dashboard; prefix stripping; timeouts |
| Auth | HS256/RS256 JWT, hashed API keys with scopes, per-route policies |
| Rate limiting | Per key/user/IP sliding window; `X-RateLimit-*`, `Retry-After`; fail-open |
| Caching | Per-route TTL, vary-on-principal, purge, stampede lock |
| Anomaly detection | 8 heuristics (<0.5 ms) + LLM verdicts (async/sync), redaction, circuit breaker, daily cap |
| Observability | Partitioned audit logs, metrics API, dashboard: overview, traffic, anomalies, keys, routes, logs |
| Ops | Multi-stage Docker, `/healthz` `/readyz`, Prometheus `/metrics`, Fly.io config |

## Results
- **Load:** {{500 rps, 0 × 5xx, 429s within ±X %, p95 Y ms}} — [`docs/results/ratelimit-k6.txt`](…)
- **Cache:** {{hit ratio Z % on read-heavy mix}} — [`docs/results/cache-k6.txt`](…)
- **Anomaly eval (200 samples):** precision {{0.xx}}, recall {{0.xx}}, F1 {{0.xx}}; est. cost {{$/day}} at 1M req/day — [`docs/results/anomaly-eval.md`](…)

## Configuration
See [`.env.example`](.env.example) and the route schema in [`docs/03-API-SPEC.md`](docs/03-API-SPEC.md). Minimal `routes.yaml`:
```yaml
routes:
  - service: orders
    upstream: http://orders:3000
    auth_required: true
    rate_limit: { window_seconds: 60, max_requests: 100 }
    cache_ttl_seconds: 30
    anomaly_mode: async
```

## Security notes
{{Honest paragraph from 11 §5: enforced vs best-effort vs out of scope. Mention exactly what is sent to the LLM provider.}}

## Project structure
```
apps/gateway      NestJS gateway + worker
apps/dashboard    React admin UI
apps/mock-upstream
packages/shared   DTO types
docs/             PRD, architecture, ADRs, specs, results
load/             k6 scripts
```

## Roadmap (v1.1)
Token-bucket policy · custom-trained classifier via `LocalHttpProvider` · 5-minute metric rollups · admin audit table · Redis Sentinel notes.

## Development
```bash
pnpm install && pnpm -r test          # unit + integration (needs Docker for testcontainers)
pnpm --filter @omnigate/gateway start:dev
pnpm --filter @omnigate/dashboard dev
pnpm eval:anomaly                     # anomaly eval harness
k6 run load/ratelimit.js
```

## License
{{MIT}}
