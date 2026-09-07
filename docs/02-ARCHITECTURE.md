# 02 · Architecture & Design Decisions

## 1. Context and constraints
- Solo developer, 9 weeks, existing NestJS/React skills.
- Must run locally with one command and deploy as a single container + managed data stores.
- Must add ≤15 ms p95 overhead; LLM must never block the hot path unless a route opts in.

## 2. High-level design

```
                    ┌──────────────────────────────────────────────────────────────┐
                    │                      GATEWAY (NestJS)                        │
  Client ──HTTP──▶  │  RequestId ▶ Logger ▶ AuthGuard ▶ RateLimitGuard ▶ Cache      │ ──▶ Upstream A
  (JWT / API key)   │  ▶ AnomalyPreScreen ▶ ProxyController ▶ AuditInterceptor     │ ──▶ Upstream B
                    │                                                              │ ──▶ Mock upstream
                    │  AdminModule (/admin/v1)   Health (/healthz,/readyz)         │
                    └────┬───────────────┬───────────────────────┬─────────────────┘
                         │               │                       │
                    ┌────▼────┐     ┌────▼─────┐          ┌──────▼──────┐
                    │  Redis  │     │ Postgres │          │  LLM API    │
                    │ limits  │     │ keys     │          │ (adapter)   │
                    │ cache   │     │ routes   │          └──────▲──────┘
                    │ BullMQ  │     │ audit    │                 │
                    └────┬────┘     │ anomalies│          ┌──────┴──────┐
                         │          └────▲─────┘          │ Worker      │
                         └── jobs ───────┴────────────────│ (BullMQ)    │
                                                          │ audit batch │
                                                          │ llm classify│
                                                          └─────────────┘
  ┌───────────────────┐
  │ Dashboard (React) │ ──▶ /admin/v1/* (JWT admin session)
  └───────────────────┘
```

The **worker** is the same Node image started with `WORKER=true`; in v1 it can run inside the gateway process (one container), and be split out later.

## 3. Request lifecycle (hot path)

| Step | Component | Fails how | Adds |
|------|-----------|-----------|------|
| 1 | `RequestIdMiddleware` | never | `X-Request-Id` |
| 2 | `RouteResolver` | 404 problem+json if no route matches `/api/{service}/*` | `req.route` (upstream, policies) |
| 3 | `AuthGuard` (JWT or API key) | 401/403 | `req.principal {type, id, scopes}` |
| 4 | `RateLimitGuard` | 429 + `Retry-After`; **fails open** on Redis error | `X-RateLimit-Limit/Remaining/Reset` |
| 5 | `CacheInterceptor` (GET only) | serve HIT and short-circuit; MISS continues | `X-Cache` |
| 6 | `AnomalyPreScreen` | heuristic score; enqueue LLM job if score ≥ 0.4 or sampled; **sync** routes await LLM ≤800 ms then 403 if ≥0.9 | `req.anomaly {heuristicScore}` |
| 7 | `ProxyController` → `http-proxy-middleware` | 502 on upstream error, 504 on timeout (default 30 s) | strips hop-by-hop + `X-API-Key`; adds `X-Forwarded-*` |
| 8 | `AuditInterceptor` | never blocks; pushes log record into in-memory buffer → BullMQ every 1 s / 500 records | — |

Everything after step 8 is off the hot path: the worker drains audit batches into Postgres with a single multi-row `INSERT`, and runs LLM classification jobs.

## 4. Module layout (NestJS)

```
apps/gateway/src
├── main.ts                      # bootstrap, body limit 1 MB, trust proxy
├── app.module.ts
├── config/                      # zod-validated env + routes.yaml loader
├── common/
│   ├── middleware/request-id.middleware.ts
│   ├── filters/problem-details.filter.ts   # RFC 7807 for all errors
│   ├── logging/logger.service.ts           # pino
│   └── redis/redis.module.ts               # ioredis client + Lua script loader
├── routing/                     # RouteResolver, route registry (yaml + DB)
├── auth/                        # JwtStrategy, ApiKeyStrategy, AuthGuard
├── rate-limit/                  # RateLimitGuard, policies, lua/sliding_window.lua
├── cache/                       # CacheInterceptor, key builder, purge service
├── anomaly/                     # heuristics/, llm/ (provider interface + adapters), queue
├── proxy/                       # ProxyController + header sanitizer
├── audit/                       # AuditInterceptor, buffer, batch writer job
├── admin/                       # api-keys, routes, policies, metrics, anomalies controllers
├── health/
└── prisma/                      # schema.prisma, migrations, raw SQL for audit table
apps/dashboard/src               # React (see 07)
packages/shared                  # DTO types shared by gateway + dashboard
```

## 5. Data flow for configuration
- **Boot:** `routes.yaml` → in-memory registry. Phase 4 adds DB routes; registry refreshes every 30 s (or on admin write via Redis pub/sub `routes:changed`).
- **API keys:** created via Admin API; raw key shown once; stored as `sha256(pepper + key)`; prefix (first 8 chars) stored for lookup + display.
- **Policies:** rows in `rate_limit_policies`, referenced by key and/or route; route policy wins over key policy.

## 6. Scale and reliability
| Concern | v1 answer | Revisit when |
|---------|-----------|--------------|
| Horizontal scaling | Stateless gateway; all state in Redis/Postgres → run N replicas | >2k rps |
| Redis outage | Rate limit + cache fail open; anomaly queue drops jobs; alert via log | Before real production use → Redis Sentinel/managed HA |
| Postgres outage | Gateway keeps serving (routes cached in memory); audit buffer drops oldest after 50k records | Same as above |
| Log volume | Monthly partitions on `audit_logs`, BRIN index on `ts`, 30-day retention job | >10M rows/month |
| LLM cost/latency | Heuristic gate + 2% sampling + async default + circuit breaker (open after 5 consecutive failures, 60 s) | If sync mode becomes common |

## 7. Architecture Decision Records

### ADR-001: NestJS (Express adapter) instead of bare Express
**Status:** Accepted · **Date:** 7 Sep 2026
**Context:** The plan says "Express & Proxy". You work in NestJS daily. The gateway's concerns (auth, rate limit, cache, audit) are cross-cutting.
**Options:**
| | Bare Express | NestJS on Express | Fastify |
|---|---|---|---|
| Complexity | Low | Medium | Medium |
| Cross-cutting structure | Manual middleware chains | Guards/Interceptors/Filters built in | Hooks |
| Team familiarity | High | **Highest** | Low |
| Raw throughput | Good | Good (same engine) | Best |
| Proxy lib compatibility | Native | `http-proxy-middleware` works via `@Req()/@Res()` passthrough | Needs `@fastify/http-proxy` |
**Decision:** NestJS with `@nestjs/platform-express`. Register the proxy as raw middleware on the `/api` prefix and keep guards in front of it.
**Consequences:** Slightly more boilerplate; DI makes testing guards trivial; README can still say "Express under the hood". Revisit if p95 overhead exceeds 15 ms (then try Fastify adapter).

### ADR-002: Sliding-window log in Redis (Lua) as the rate-limit algorithm
**Status:** Accepted
**Options:** Fixed window (simple, 2× burst at boundaries) · Sliding window counter (approximate, cheap) · **Sliding window log** (exact, O(n) memory per key per window) · Token bucket (burst-friendly, more state).
**Decision:** Sliding window log with ZSET, executed atomically in Lua. Exactness is worth the memory at v1 volumes (max = 1000 entries/key/window). Token bucket documented as v1.1 "burst" policy type.
**Consequences:** One round trip per request; memory ≈ 100 B × max × active keys. See `05` for the script.
**Measured (Sprint 3):** 500 rps for 60 s over 20 principals: 30,002 requests, exactly 2,000 accepted, 28,001 rejected vs 28,000 expected, 0 × 5xx, p95 1.32 ms for served requests (`docs/results/ratelimit-k6.txt`). Redis stopped mid-run: 0 × 5xx, fail-open with `X-RateLimit-Degraded`, reconnect ~1 s after restart. The shipped script evaluates several buckets (policy + anonymous cap) in one call and checks the throttle flag first; see `05 §1.2`.

### ADR-003: LLM classification is asynchronous by default
**Status:** Accepted
**Context:** LLM p50 latency is 300–1500 ms; the gateway target overhead is 15 ms.
**Decision:** Every request gets a ≤0.5 ms heuristic score inline. LLM runs in a BullMQ worker and writes `anomaly_events`. Routes may opt into `anomaly_mode: sync` with an 800 ms timeout that fails open. Enforcement for async mode is *reactive*: repeated high scores → temporary key throttle (Redis flag checked by RateLimitGuard).
**Consequences:** Blocking is best-effort for most routes; detection quality does not depend on latency budget; cost is controllable via gating + sampling.

### ADR-004: Prisma for entities, raw SQL for audit logs
**Status:** Accepted
**Decision:** Prisma manages `api_keys`, `routes`, `rate_limit_policies`, `anomaly_events`, `admin_users` and migrations. `audit_logs` is created by a raw SQL migration (partitioning, BRIN) and written with `prisma.$executeRaw` multi-row inserts; metrics queries are raw SQL with `date_bin`.
**Consequences:** Typed CRUD where it matters; no ORM overhead on the high-volume table.

### ADR-005: pnpm workspaces monorepo, single Docker image for gateway+worker
**Status:** Accepted
**Decision:** `apps/gateway`, `apps/dashboard`, `packages/shared`. The dashboard is built to static files and served by the gateway under `/dashboard` in production (one deployable). Worker runs in-process in v1 (`WORKER_INLINE=true`).
**Consequences:** One deploy, one URL; shared DTO types; can split later without code changes beyond env flags.

### ADR-006: Fly.io as default deploy target
**Status:** Proposed (confirm in Sprint 1)
**Decision:** Fly.io app + Fly Postgres + Upstash Redis (or Fly Redis). Alternatives: Railway (simplest UI), AWS ECS Fargate (most "enterprise", ~2 extra days).
**Consequences:** Free/cheap tier sufficient; `fly.toml` committed; health checks map to `/readyz`.
