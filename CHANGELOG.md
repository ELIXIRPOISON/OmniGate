# Changelog

Notable changes, newest first. Dates are the day the work landed on `main`.

## v1.0.0 — 2026-09-15

First release. A self-hosted API gateway that runs as one container: auth, rate limiting, caching,
learned anomaly detection, a partitioned audit log, an admin API and a dashboard, all on one port.

### Gateway

- **Routing and proxying.** Services registered in the database or `routes.yaml`, database wins.
  Bodies up to `MAX_BODY_BYTES` are buffered for the anomaly pre-screen and replayed byte-for-byte;
  larger ones are refused with 413. Hop-by-hop and internal headers are stripped, `X-Forwarded-*` honoured
  only when a proxy is trusted. Timeouts enforced by the gateway's own timer, because the proxy
  engine reports a socket reset instead of a timeout.
- **Auth.** HS256 or RS256 JWTs and API keys, with scopes. `JWT_ISSUER` and `JWT_AUDIENCE` pin the
  claims when the JWKS belongs to a shared identity provider. Keys are stored as peppered hashes with a
  prefix lookup, cached in Redis including negative results, compared in constant time.
- **Rate limiting.** A sliding window written in Lua, evaluating every applicable bucket in one
  atomic call. A refused request consumes nothing in any bucket. Rate-limit headers on every
  response; `X-RateLimit-Degraded` when Redis is unreachable and the limiter fails open.
- **Response cache.** Per route TTL on GET and HEAD, keyed with vary-on-principal, `X-Cache` and
  `Age` headers, a stampede lock and an admin purge.
- **Anomaly detection.** `LLM_PROVIDER` defaults to `fake`, so a deployment with no model boots and
  runs heuristics plus the learned schema. Nine signals scored inline in under a millisecond and combined with
  noisy-OR. Suspicious requests are classified after the response by any OpenAI-compatible model.
- **Audit log.** Every proxied request, buffered and batch-inserted into a monthly-partitioned table
  with a BRIN index. Old partitions are dropped on a schedule rather than deleted row by row.
- **Health.** `/healthz` for liveness, `/readyz` checking Redis and Postgres with a one-second budget
  each.
- **`/metrics`.** Prometheus text: request counts and latency histograms by route, rate-limit
  refusals, cache outcomes, anomaly blocks. Bounded label cardinality; needs `METRICS_TOKEN`.

### Detection

- Measured against **CSIC 2010**, 97,065 real requests, rather than the project's own generated set.
  Recall **0.494** at precision **1.000** by default, zero false positives across 36,000 held-out
  benign requests. Value shapes take recall to 0.772 and are opt-in because they cost precision.
- **Learned route schema.** The gateway learns which parameter names each route accepts and flags the
  rest. On its own it detects more than all eight of the original signals combined. Learning is
  poison-resistant, silent during warmup, and disables itself on routes whose parameters are
  open-ended.
- **`ANOMALY_ENFORCE`.** One switch over every refusal the anomaly stage can make, for running
  observe-only until the review queue has earned trust.
- **Escalate-only second stage.** A model may raise a score, never lower one, except on a confident
  `benign`. Added after a measured run in which a weak model overwrote confident findings and took
  recall from 0.900 to 0.433.

### Control plane

- Admin API for routes, keys, policies, metrics, logs and anomaly review, behind its own JWT.
- Dashboard with seven screens, served by the gateway itself so a deploy is one container.
- API keys shown once on create and rotate; destructive actions require typing the resource name.

### Operations

- Single production image, 392 MB, non-root, with a healthcheck. The Prisma CLI and the query
  compilers for four unused databases are kept out of it.
- Migrations run from their own stage, which the gateway waits on.
- Refuses to boot in production on the four placeholder secrets `.env.example` ships with and on
  `EXPOSE_ANOMALY_SCORE=true`.
- `compose.prod.yml` is a production template: empty route table, no mock upstream, observe-only
  anomaly mode, stores overridable by URL, port bound to loopback. `compose.demo.yml` layers the
  five-minute tour on top.
- The seed creates the admin and the three policies; `--demo` adds the demo routes and key.
- Images published to GHCR on each release: `omnigate` and `omnigate-migrate`.
- Security headers on the dashboard and control plane, deliberately not on proxied responses.
- `tools/smoke-prod.sh`: 27 end-to-end checks against the built image.

### Measured, and written down

| | |
|---|---|
| Rate limiter | 30,002 requests, 28,001 refused against 28,000 expected, 0 × 5xx, p95 1.32 ms |
| Redis outage | 10 s mid-run, 0 × 5xx, 1,113 degraded responses, recovery ~1 s |
| Audit overhead | Buffered writes, measured against the p95 budget |
| Detection | CSIC 2010, recall 0.494 at precision 1.000 |
| Classification latency | 1.29 s warm and serial on `qwen2.5:7b`, which is why sync mode is opt-in |

`docs/results/` holds the raw artefacts, including the experiments that failed.

### Known limitations

- The behavioural signals are unmeasured. CSIC has no timeline and no sender identity, so enumeration
  and credential-stuffing detection rests on a synthetic dataset.
- Schema-learning safeguards are untested against real conditions for the same reason: no
  deployments, no attacker arriving mid-learning.
- Parameter tampering is the largest remaining miss category and needs value-range learning per route.
- The LLM stage contributes four detections in 1,254 on real data. It is kept because the interface
  is sound and a better model may earn its place, not because it is currently earning it.
- No multi-tenancy, gRPC, WebSockets or service discovery. Out of scope for v1.
