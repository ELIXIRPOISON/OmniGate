# OmniGate - AI-powered API Gateway

> A self-hosted gateway that fronts your microservices with JWT/API-key auth, Redis-backed rate limiting and caching, LLM-assisted anomaly detection, and a real-time React dashboard.

**Status:** Sprint 2 of 9 (kickoff 7 Sep 2026, v1.0 target 6 Nov 2026). Phase 1 core gateway: routing, proxying, JWT and API-key auth, readiness. Nothing is deployed yet.
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
