# OmniGate - AI-powered API Gateway

> A self-hosted gateway that fronts your microservices with JWT/API-key auth, Redis-backed rate limiting and caching, LLM-assisted anomaly detection, and a real-time React dashboard.

**Status:** Sprint 1 of 9 (kickoff 7 Sep 2026, v1.0 target 6 Nov 2026). Nothing is deployed yet.
**Stack:** NestJS 12 (Express) · Redis 7 · PostgreSQL 16 + Prisma · BullMQ · React 19 + Vite · TypeScript 6 · Docker

## Request lifecycle

`X-Request-Id` → route resolve → auth (JWT | API key) → rate limit (Redis Lua sliding window) → cache (GET) → heuristic anomaly score → proxy → async audit log.
LLM classification runs off the hot path by default; routes can opt into synchronous blocking with an 800 ms fail-open timeout.

Full design: [`docs/02-ARCHITECTURE.md`](docs/02-ARCHITECTURE.md). Start with [`docs/00-INDEX.md`](docs/00-INDEX.md).

## Project structure

```
apps/gateway       NestJS gateway + worker (data plane, admin API)
apps/dashboard     React admin UI
packages/shared    DTO / contract types shared by both
docs/              PRD, architecture + ADRs, specs, delivery plan, journal
```

## Development

Requires Node 22 (`.nvmrc`), pnpm 10, and Docker.

```bash
cp .env.example .env
pnpm install
pnpm build            # builds shared first, then the apps
pnpm typecheck
pnpm lint
pnpm test
pnpm dev:gateway      # http://localhost:8080
pnpm dev:dashboard    # http://localhost:5173
```

The day-by-day plan lives in [`docs/08-DELIVERY-PLAN.md`](docs/08-DELIVERY-PLAN.md); the daily journal in [`docs/journal.md`](docs/journal.md).

## License

MIT
