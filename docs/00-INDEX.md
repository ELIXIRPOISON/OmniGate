# AI API Gateway — Project Document Set

**Project codename:** `omnigate` (rename freely)
**Owner:** you (solo dev acting as TPM + engineer)
**Kickoff:** Mon 7 Sep 2026 · **Target v1.0 ship:** Fri 6 Nov 2026 (9 weeks, 1-week sprints)
**Doc status:** v1.0 — ready to execute

---

## How to use this pack

Read in this order on day 1, then keep `08-DELIVERY-PLAN.md` open every day.

| # | Document | Purpose | Read when |
|---|----------|---------|-----------|
| 00 | **INDEX** (this file) | Map, assumptions, timeline | Day 1 |
| 01 | **PRD** | What we're building, for whom, and how we know it's done | Day 1 |
| 02 | **ARCHITECTURE** | System design, request lifecycle, ADRs | Day 1, before writing code |
| 03 | **API-SPEC** | Gateway + Admin API contracts, headers, error format | Sprint 1 onward |
| 04 | **DATA-MODEL** | Postgres DDL, Redis key design | Sprint 1 (keys), Sprint 7 (logs) |
| 05 | **RATE-LIMIT-AND-CACHE** | Algorithm choice, Lua script, cache policy | Sprint 3–4 |
| 06 | **AI-ANOMALY-DETECTION** | Pipeline, prompt, schema, eval plan | Sprint 5–6 |
| 07 | **DASHBOARD-SPEC** | Screens, charts, queries behind them | Sprint 7–8 |
| 08 | **DELIVERY-PLAN** | Sprint-by-sprint backlog, acceptance criteria, DoR/DoD, risks | Every day |
| 09 | **TEST-STRATEGY** | What to test, how, coverage targets | Sprint 1 onward |
| 10 | **DEPLOYMENT-RUNBOOK** | Docker, compose, env vars, deploy + rollback checklist | Sprint 9 (skim in Sprint 1) |
| 11 | **SECURITY-THREAT-MODEL** | Threats and mitigations per phase | Sprint 1, revisit Sprint 5 |
| 12 | **README-TEMPLATE** | The public README you'll ship with the repo | Sprint 9 |

---

## Decisions already made (assumptions — change them if you disagree)

| Area | Decision | Why |
|------|----------|-----|
| Gateway framework | **NestJS 11 on the Express adapter** + `http-proxy-middleware` | Your primary stack; guards/interceptors map 1:1 to gateway concerns (auth, rate-limit, logging). Plain Express is a fine fallback — nothing in these docs depends on Nest-only features. |
| Language / runtime | TypeScript 5, Node 22 LTS, pnpm workspaces monorepo | One repo, three packages: `apps/gateway`, `apps/dashboard`, `packages/shared` |
| Cache + rate limit | Redis 7 via `ioredis`, atomic Lua scripts | Correctness under concurrency; single dependency for cache, limits, and job queue |
| Database / ORM | PostgreSQL 16 + Prisma | Migrations + typed client; audit log table uses raw SQL for performance |
| Async work | BullMQ (on the same Redis) | LLM calls and audit-log batching off the hot path |
| LLM provider | Pluggable `LlmProvider` interface; OpenAI as default adapter | Matches your plan; swappable for Anthropic, a local model, or your own classifier |
| Dashboard | React 18 + Vite + TanStack Query + Recharts + Tailwind | Fast to build, matches your plan |
| Deploy target | Docker image → **Fly.io or Railway** (managed Postgres + Redis) | Cheapest 1-week path; the image is provider-agnostic, so AWS ECS/GCP Cloud Run work too |
| Auth to gateway | JWT (HS256/RS256) **or** API key (`X-API-Key`) | Two client types: browser/SPA users and machine clients |
| Admin auth | Single admin user, JWT session | Not multi-tenant in v1 |

## Explicit non-goals for v1.0
- Multi-tenancy / organisations
- gRPC or WebSocket proxying
- Service discovery (upstreams are static config + DB rows)
- Training a custom ML model (heuristics + LLM only; a custom classifier is a documented v1.1 stretch)
- HA Redis / Postgres (single instances are fine for v1)

## Timeline at a glance

```
Sep 07 ─ S1 ─┐
Sep 14 ─ S2 ─┴─ Phase 1  Core Gateway ────────── M1  Gateway Alpha      (Sep 18)
Sep 21 ─ S3 ─┐
Sep 28 ─ S4 ─┴─ Phase 2  Traffic Control ─────── M2  Limits + Cache     (Oct 02)
Oct 05 ─ S5 ─┐
Oct 12 ─ S6 ─┴─ Phase 3  AI Integration ──────── M3  Anomaly Guard      (Oct 16)
Oct 19 ─ S7 ─┐
Oct 26 ─ S8 ─┴─ Phase 4  Observability ───────── M4  Dashboard          (Oct 30)
Nov 02 ─ S9 ─── Phase 5  Productionizing ──────── M5  v1.0 SHIP          (Nov 06)
Nov 09 ─ buffer week (use only if a milestone slipped)
```

## Day-1 checklist
- [ ] Read 01, 02, 08 end-to-end (≈45 min)
- [ ] Create the repo and run the bootstrap commands in `08-DELIVERY-PLAN.md § Sprint 1`
- [ ] Copy the Sprint 1 stories into your tracker (GitHub Projects / Linear / Notion)
- [ ] Set a recurring Friday 30-min "sprint review" with yourself: demo, tick the exit criteria, plan next week
