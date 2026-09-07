# OmniGate - AI-powered API Gateway

> A self-hosted gateway that fronts your microservices with JWT/API-key auth, Redis-backed rate limiting and caching, LLM-assisted anomaly detection, and a real-time React dashboard.

**Status:** Sprint 1 of 9 (kickoff 7 Sep 2026, v1.0 target 6 Nov 2026). Phase 1 core gateway in progress; nothing is deployed yet.
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
docker compose up --build
# in another terminal
curl -i localhost:8080/api/mock/items          # proxied to the mock upstream, X-Request-Id on the response
curl -i localhost:8080/api/nope                # 404 application/problem+json
curl -i localhost:8080/api/mock/echo -H 'X-API-Key: test'   # see what the upstream receives
```

The stack is gateway (hot reload) on :8080, mock upstream on :3001, Redis on :6379 and Postgres on :5432.
After changing dependencies run `docker compose build && docker compose up -V`.

## Development

Requires Node 22 (`.nvmrc`), pnpm 10, and Docker.

```bash
cp .env.example .env
pnpm install
pnpm build            # builds shared first, then the apps
pnpm typecheck
pnpm lint
pnpm test
pnpm --filter @omnigate/gateway test:e2e   # proxy behaviour against an in-process upstream
pnpm --filter @omnigate/mock-upstream start:dev   # http://localhost:3001
pnpm dev:gateway      # http://localhost:8080 (reads .env from the repo root)
pnpm dev:dashboard    # http://localhost:5173
```

Route table: `apps/gateway/routes.yaml` (schema in [`docs/03-API-SPEC.md`](docs/03-API-SPEC.md)). Every variable the gateway reads is validated at boot; a missing or malformed one prints a readable list and exits.

The day-by-day plan lives in [`docs/08-DELIVERY-PLAN.md`](docs/08-DELIVERY-PLAN.md); the daily journal in [`docs/journal.md`](docs/journal.md).

## License

MIT
