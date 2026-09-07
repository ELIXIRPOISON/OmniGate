# 01 · Product Requirements Document — AI API Gateway

**Version:** 1.0 · **Date:** 7 Sep 2026 · **Status:** Approved for build

## 1. One-liner
A self-hosted API gateway that fronts your microservices, enforces auth and rate limits, caches responses, and uses an LLM to flag abusive or malicious traffic — with a React dashboard to see it all.

## 2. Problem
Every microservice repeats the same plumbing (auth, logging, throttling) and none of them can see traffic patterns across services. Attackers and scrapers exploit that blind spot. Existing gateways (Kong, Tyk, AWS API Gateway) are heavy or costly for side projects and don't offer AI-driven anomaly detection out of the box.

## 3. Goals
| # | Goal | Measure |
|---|------|---------|
| G1 | Single entry point for N upstream services | Any HTTP service registered by config/DB is reachable via the gateway |
| G2 | Protect upstreams from abuse | Rate limits enforced with <1% error under 500 rps load test |
| G3 | Reduce upstream load for read traffic | ≥60% cache hit ratio on cacheable GET routes in demo |
| G4 | Surface malicious/abnormal traffic | ≥85% precision, ≥80% recall on a 200-sample labelled eval set |
| G5 | Operator visibility | Dashboard shows RPS, errors, p95 latency, 429s, anomalies with <15 s lag |
| G6 | Portfolio-grade delivery | Dockerized, deployed on a public URL, architecture README |

## 4. Non-goals (v1.0)
Multi-tenancy, gRPC/WebSockets, service discovery, custom-trained ML model, HA data stores, billing, OAuth provider features.

## 5. Users & personas
| Persona | Needs | Touchpoints |
|---------|-------|-------------|
| **API consumer (machine)** | Stable URL, clear 401/429 semantics, rate-limit headers | Gateway `/api/*` |
| **API consumer (SPA user)** | JWT-based access, low latency | Gateway `/api/*` |
| **Operator / you** | Register routes & keys, watch traffic, review anomalies | Dashboard, Admin API |
| **Reviewer / recruiter** | Understand design quickly, run it locally in 5 min | README, `docker compose up` |

## 6. Functional requirements

### Phase 1 — Core Gateway
- FR-1.1 Forward any HTTP method from `/api/{service}/*` to the configured upstream, preserving body, query, and safe headers.
- FR-1.2 Validate `Authorization: Bearer <JWT>` (HS256 or RS256/JWKS) **or** `X-API-Key` on protected routes; reject with 401/403 using RFC 7807 problem+json.
- FR-1.3 Attach a `X-Request-Id` (generated if absent) to every request and response; propagate to upstream.
- FR-1.4 Structured JSON request/response log line per request (method, path, status, latency, key id, request id).
- FR-1.5 `/healthz` (liveness) and `/readyz` (Redis + Postgres reachable).
- FR-1.6 Route config loaded from `routes.yaml` at boot (DB-backed routes arrive in Phase 4).

### Phase 2 — Traffic Control
- FR-2.1 Per-API-key (or per-IP for anonymous) sliding-window rate limit with configurable window and max; return `429` + `Retry-After` + `X-RateLimit-*` headers.
- FR-2.2 Per-route override of the limit policy.
- FR-2.3 Response cache for GET routes with per-route TTL; `X-Cache: HIT|MISS` header; bypass on `Cache-Control: no-cache`.
- FR-2.4 Admin endpoint to purge cache by route prefix.

### Phase 3 — AI Integration
- FR-3.1 Heuristic pre-screen on every request (SQLi/XSS/traversal patterns, payload size, entropy, burst behaviour) producing a 0–1 score.
- FR-3.2 LLM classification (async by default) for requests above threshold or in a random sample; output structured verdict `{score, categories, reasoning}`.
- FR-3.3 Optional **sync mode** per route: block with 403 when LLM score ≥ block threshold, with a hard 800 ms timeout that fails open.
- FR-3.4 Automatic key throttling after N high-score events within a window (configurable, default off).
- FR-3.5 All anomaly events persisted with redacted payload sample.

### Phase 4 — Observability
- FR-4.1 Async, batched audit log writes to Postgres (no per-request synchronous DB write).
- FR-4.2 Admin API: CRUD for API keys, routes, rate-limit policies; metrics queries; anomaly review.
- FR-4.3 React dashboard: Overview, Traffic, Anomalies, API Keys, Routes, Logs.
- FR-4.4 Dashboard auto-refreshes every 10 s.

### Phase 5 — Productionizing
- FR-5.1 Multi-stage Dockerfile for gateway and dashboard; `docker compose up` runs the full stack + a mock upstream.
- FR-5.2 Deployed to a public URL with managed Postgres and Redis.
- FR-5.3 README with architecture diagram, request lifecycle, design decisions, and a 5-minute quick start.

## 7. Non-functional requirements
| NFR | Target |
|-----|--------|
| Gateway overhead (p95, cache miss, no LLM sync) | ≤ 15 ms added latency on localhost |
| Throughput | 500 rps sustained on a single 1-vCPU container without errors |
| Availability of protections | Redis down → rate limiting **fails open** with a warning log; auth still enforced |
| LLM budget | ≤ $5/day at 1M requests/day (achieved by sampling + heuristic gating) |
| Log retention | 30 days, then partition drop |
| Security | No secrets in repo; API keys stored hashed; hop-by-hop headers stripped |
| Test coverage | ≥ 80% lines on gateway core modules |

## 8. Success metrics for the portfolio outcome
- Public demo URL works end-to-end on a fresh browser.
- README explains the design in under 3 minutes of reading.
- Load test artefact (k6 summary) and anomaly eval results committed to `/docs/results`.

## 9. Release plan
| Milestone | Date | Gate |
|-----------|------|------|
| M1 Gateway Alpha | 18 Sep | FR-1.x pass; integration tests green |
| M2 Limits + Cache | 2 Oct | k6 shows correct 429 behaviour; cache hit ratio measured |
| M3 Anomaly Guard | 16 Oct | Eval set precision/recall met; cost estimate documented |
| M4 Dashboard | 30 Oct | All six screens functional against real data |
| M5 v1.0 Ship | 6 Nov | Public URL live; README done; tag `v1.0.0` |

## 10. Open questions (resolve by end of Sprint 1)
1. Will the demo upstream be one of your existing microservices or the bundled mock service? (Default: bundled mock + one real one if available.)
2. Which LLM/provider account do you have credits on? (Default: OpenAI; adapter interface makes this a 1-file change.)
3. Deploy platform: Fly.io vs Railway vs your existing cloud account? (Default: Fly.io.)
