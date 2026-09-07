# Journal

Five lines a day: done / blocked / decided. Newest first.

## 2026-09-08 (Tue, later) - Sprint 2
- Done: S2-01 Prisma 7 schema + `init` migration + idempotent seed (admin, 3 policies, 2 routes, demo key printed once; re-seeding rotates it). S2-02 JWT verifier (HS256 secret / RS256 JWKS, alg pinned, `sub`+`exp` required, 60 s skew). S2-03 API-key strategy (format check, prefix lookup with Redis read-through incl. negative caching, constant-time hash compare, 401/403 split, lastUsedAt at most once a minute). S2-04 AuthGuard on the proxy controller with scope check, anon principal = IP, `X-Gateway-Principal` forwarded. S2-05 `/readyz` (Redis PING + `SELECT 1`, 1 s budget each, 503 degraded). S2-06 Testcontainers integration suite + coverage artifact in CI. S2-07 README/spec pass.
- Decided: Prisma 7 conventions (prisma.config.ts, generated client in src/generated, pg driver adapter) instead of the doc pack's Prisma 6 shape; `pnpm gen` produces shared dist + client before every root script.
- Decided: presented credentials are always validated (even on open routes); scoped routes imply auth; credential store down + uncached key -> 503, never a silent allow.
- Decided: Redis client never queues offline and every call goes through `safe()`; a missing Redis degrades readiness and the key cache but not auth.
- Next: Sprint 3 - Redis Lua sliding window, RateLimitGuard + headers, anon per-IP cap, k6 rate-limit scenario, chaos test.

## 2026-09-08 (Tue) - Sprint 1, day 2
- Done: S1-02 config (zod env + routes.yaml with `${VAR:-default}`), S1-03 request-id + pino one-line-per-request, S1-04 route resolver, S1-05 proxy (streams bodies, strips hop-by-hop/X-API-Key/X-Gateway-*, X-Forwarded-* trust-proxy aware, 502/504), S1-06 mock upstream, S1-07 RFC 7807 filter, S1-08 compose stack. 15 e2e + 55 unit tests green.
- Decided: route resolution runs as Nest middleware bound to the ProxyController; the proxy is a controller so Sprint 2 guards slot in front of it (ADR-001). Timeout is enforced by the gateway's own timer (time to upstream headers) because the proxy engine's built-in timeout reports a plain socket reset.
- Decided: Nest body parsing is off for the whole app (risk R4); Content-Length above MAX_BODY_BYTES is rejected with 400 before proxying, chunked bodies get capped in Sprint 5 with the anomaly pre-screen.
- Decided: mock upstream runs on Node's built-in TypeScript type stripping in dev (`node --watch src/main.ts`), no extra tooling.
- Blocked: nothing. Sprint exit demo passes locally and in compose.
- Next: Sprint 2 - Prisma schema + seed, JWT and API-key strategies, AuthGuard, /readyz, testcontainers harness.

## 2026-09-07 (Mon) - Sprint 1, day 1
- Done: repo bootstrapped as a pnpm workspace (`apps/gateway` NestJS, `apps/dashboard` Vite React, `packages/shared`), docs pack committed, `.env.example`, `routes.yaml`, Node 22 pin, CI skeleton. Build, typecheck, lint, unit and e2e tests green.
- Decided: repo lives at `~/PP/OmniGate`; git identity and SSH are scoped to `~/PP` so commits are always the personal account.
- Decided: package names are scoped (`@omnigate/gateway`, `@omnigate/dashboard`, `@omnigate/shared`); the doc pack's `pnpm --filter` commands were updated to match.
- Decided: build on what the current scaffolds produce rather than the doc pack's assumed versions: NestJS 12 (ESM), React 19, Vite 8, TypeScript 6, Vitest + oxlint (not Jest + ESLint). Prisma pinned to 7.10.0 because the npm `latest` tag currently points at an 8.0 release candidate.
- Decided: `LLM_PROVIDER=fake` is the local default so nothing needs an API key until Sprint 6.
- Next: S1-02 config module, S1-03 request-id + pino, S1-04 route resolver, S1-05 proxy, S1-06 mock upstream, S1-07 problem-details filter, S1-08 compose.
