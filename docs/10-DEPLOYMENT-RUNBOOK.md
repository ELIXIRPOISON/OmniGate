# 10 · Deployment Runbook

**When to use:** first production deploy (Sprint 9) and every release after. **Prereqs:** Docker 27+, `flyctl` logged in, repo secrets set, CI green on `main`.

## 1. Dockerfile (`apps/gateway/Dockerfile`, build context = repo root)
```dockerfile
# ---- deps ----
FROM node:22-alpine AS deps
RUN corepack enable
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/gateway/package.json apps/gateway/
COPY apps/dashboard/package.json apps/dashboard/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile

# ---- build ----
FROM deps AS build
COPY . .
RUN pnpm --filter @omnigate/shared build \
 && pnpm --filter @omnigate/dashboard build \
 && pnpm --filter @omnigate/gateway prisma generate \
 && pnpm --filter @omnigate/gateway build \
 && pnpm --filter @omnigate/gateway deploy --prod /out

# ---- runtime ----
FROM node:22-alpine AS runtime
RUN addgroup -S app && adduser -S app -G app
WORKDIR /app
COPY --from=build --chown=app:app /out ./
COPY --from=build --chown=app:app /repo/apps/dashboard/dist ./public/dashboard
USER app
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "dist/main.js"]
```
Target image < 250 MB. Verify with `docker image ls`.

## 2. Compose files
`compose.yml` (dev): gateway (bind-mounted, `pnpm start:dev`), mock-upstream, redis:7-alpine (`--maxmemory 256mb --maxmemory-policy allkeys-lru`), postgres:16-alpine with named volume, dashboard (Vite).
`compose.prod.yml`: built gateway image + redis + postgres — used to smoke-test the production image locally before `fly deploy`.
`compose.test.yml`: same as prod + seeded data, used by Playwright.

## 3. Environment variables (`.env.example`)
| Var | Required | Default | Purpose |
|-----|----------|---------|---------|
| `PORT` | | 8080 | |
| `NODE_ENV` | | development | |
| `LOG_LEVEL` | | info | pino |
| `TRUST_PROXY` | | false | set `true` behind Fly/ALB |
| `DATABASE_URL` | ✔ | | Postgres |
| `REDIS_URL` | ✔ | | `rediss://` on Upstash |
| `ROUTES_FILE` | | ./routes.yaml | bootstrap routes |
| `JWT_SECRET` | one of | | HS256 |
| `JWT_JWKS_URL` | one of | | RS256 |
| `API_KEY_PEPPER` | ✔ | | 32+ random bytes; rotating it invalidates all keys |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | ✔ (seed) | | initial admin |
| `ADMIN_JWT_SECRET` | ✔ | | separate from `JWT_SECRET` |
| `CORS_ORIGIN` | | `http://localhost:5173` | dashboard origin |
| `MAX_BODY_BYTES` | | 1048576 | |
| `UPSTREAM_TIMEOUT_MS` | | 30000 | |
| `ALLOW_PRIVATE_UPSTREAMS` | | false (true in dev) | SSRF guard |
| `RL_*`, `CACHE_*` | | see `05 §3` | |
| `ANOMALY_SAMPLE_RATE` | | 0.02 | |
| `ANOMALY_GATE_THRESHOLD` | | 0.4 | |
| `ANOMALY_BLOCK_THRESHOLD` | | 0.9 | |
| `ANOMALY_AUTO_THROTTLE` | | false | |
| `LLM_PROVIDER` | | openai | `openai` \| `anthropic` \| `local` \| `fake` |
| `LLM_MODEL` | | (provider default) | |
| `LLM_API_KEY` | when provider ≠ fake | | |
| `LLM_DAILY_CALL_CAP` | | 20000 | |
| `WORKER_INLINE` | | true | run BullMQ processors in-process |
| `LOG_RETENTION_DAYS` | | 30 | |
| `EXPOSE_ANOMALY_SCORE` | | false | dev-only response header |

## 4. First deploy (Fly.io)
```bash
fly launch --no-deploy --name omnigate --region sin          # writes fly.toml
fly postgres create --name omnigate-db --region sin --vm-size shared-cpu-1x --initial-cluster-size 1
fly postgres attach omnigate-db                                 # sets DATABASE_URL
fly redis create --name omnigate-redis --region sin             # Upstash; copy REDIS_URL
fly secrets set REDIS_URL=rediss://... JWT_SECRET=$(openssl rand -hex 32) \
  API_KEY_PEPPER=$(openssl rand -hex 32) ADMIN_JWT_SECRET=$(openssl rand -hex 32) \
  ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='<strong>' LLM_API_KEY=... TRUST_PROXY=true \
  CORS_ORIGIN=https://omnigate.fly.dev
fly deploy
```
`fly.toml` essentials:
```toml
[deploy]  release_command = "node node_modules/prisma/build/index.js migrate deploy"
[http_service]  internal_port = 8080  force_https = true  auto_stop_machines = false  min_machines_running = 1
[[http_service.checks]]  path = "/readyz"  interval = "15s"  timeout = "3s"
```
Seed once: `fly ssh console -C "node dist/prisma/seed.js"`.

## 5. Release checklist (copy into the release issue)

### Pre-deploy
- [ ] CI green on `main` (lint, types, unit, integration, image build)
- [ ] `CHANGELOG.md` updated; version bumped
- [ ] New migrations reviewed; tested on a copy of prod data (`pg_dump | psql` into local)
- [ ] New env vars added to Fly secrets **before** deploy
- [ ] `docker compose -f compose.prod.yml up` smoke passes locally (`/readyz`, `/dashboard`, one proxied call)
- [ ] Rollback plan below re-read; previous image tag noted: `________`

### Deploy
- [ ] `fly deploy` completes; release command (migrate) succeeded in logs
- [ ] `/readyz` 200 from public URL
- [ ] Smoke: login to dashboard; `curl -H "X-API-Key: …" $URL/api/mock/items` → 200 with `X-Request-Id`
- [ ] Rate-limit smoke: 101 requests → 429 with headers
- [ ] Watch `fly logs` and dashboard Overview for 15 min: error rate < 1 %, p95 < 50 ms

### Post-deploy
- [ ] Tag `vX.Y.Z`; GitHub release with k6 + eval artefacts
- [ ] README demo URL/screenshots current
- [ ] Journal entry with anything surprising

### Rollback triggers
- Error rate > 5 % for 5 min · p95 > 250 ms for 5 min · `/readyz` failing · auth bypass or data-exposure suspicion (immediate)

## 6. Rollback
```bash
fly releases                       # find previous version
fly deploy --image registry.fly.io/omnigate:<previous-tag>
```
If a migration must be reverted: migrations are additive by policy; write a new "down" migration rather than editing history. Audit partitions are safe to leave.

## 7. Routine operations
| Task | Command / where |
|------|-----------------|
| Rotate a compromised API key | Dashboard → API keys → Rotate (old key 403 within 60 s) |
| Rotate `API_KEY_PEPPER` | Not supported without re-issuing all keys — document, avoid |
| Purge cache for a route | Dashboard → Routes → Purge |
| Inspect a request | Logs → search `X-Request-Id` → linked anomaly |
| Redis memory pressure | `redis-cli INFO memory`; LRU eviction handles cache; ZSETs are TTL-bounded |
| Postgres growth | `SELECT relname, pg_size_pretty(pg_total_relation_size(oid)) FROM pg_class WHERE relname LIKE 'audit_logs%'` |
| LLM spend | `redis-cli GET llm:calls:$(date +%Y%m%d)` and provider dashboard |

## 8. Escalation (solo project)
No on-call; if the public demo is down, `fly machines restart` first, then rollback. Keep a status note in the README if it stays down > 1 day.
