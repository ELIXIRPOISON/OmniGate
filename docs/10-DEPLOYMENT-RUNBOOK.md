# 10 · Deployment Runbook

**When to use:** first production deploy (Sprint 9) and every release after. **Prereqs:** Docker 27+, `flyctl` logged in, repo secrets set, CI green on `main`.

## 1. Image (`Dockerfile`, build context = repo root)

The real Dockerfile lives at the repo root. It is multi-stage and three things about it are load
bearing.

**The dashboard ships inside the gateway image.** Stage `build` runs the Vite build and the runtime
stage copies `apps/dashboard/dist` to `public/dashboard`, where `app.setup.ts` serves it. A deploy is
therefore one container, not a stack, and `docker compose -f compose.prod.yml up` gives a reviewer
the whole product on one port.

**The Prisma CLI never reaches the runtime image.** `@prisma/client` declares `prisma` and
`typescript` as *optional* peer dependencies and pnpm installs optional peers, which drags in
Prisma Studio, pglite, effect and elkjs: about 190 MB of build-time code. `auto-install-peers=false`
is not available because a frozen install refuses to disagree with the setting recorded in the
lockfile, so the `proddeps` stage removes them after installing. The gateway reaches Postgres through
`@prisma/adapter-pg` and the generated client is plain compiled TypeScript, so nothing there is
loaded at run time.

**Migrations run from their own stage.** `--target migrate` builds a one-shot container whose only
job is `prisma migrate deploy`. In compose the gateway waits on it with
`condition: service_completed_successfully`; on Fly it is the release command.

```bash
docker build -t omnigate .                            # runtime image
docker build -t omnigate-migrate --target migrate .    # migration runner
sh tools/smoke-prod.sh "$KEY"                          # end-to-end check against the running image
```

### Measured size

| | |
|---|---|
| Before pruning | 742 MB |
| After removing the Prisma CLI and its tree | 505 MB |
| After dropping unused query compilers, React and `@prisma/dev` | **392 MB** |

`docs/08` set a target of under 250 MB. That is not reachable on this stack and the target should be
read as stale rather than missed: `node:22-alpine` is 171 MB before a single dependency is installed,
and Prisma 7 ships a WebAssembly query compiler per database engine in two size variants as both CJS
and ESM. Keeping only the PostgreSQL compilers takes `@prisma/client` from 71 MB to about 19 MB,
which is the last large win available without leaving Alpine or vendoring the client.

## 2. Compose files

`compose.yml` (dev): gateway bind-mounted running `start:dev`, mock-upstream, redis:7-alpine
(`--maxmemory 256mb --maxmemory-policy allkeys-lru`), postgres:16-alpine with a named volume. The
dashboard is not in this file; run `pnpm dev:dashboard` for hot reload.

`compose.prod.yml`: the built image plus a `migrate` service that runs to completion first, redis and
postgres. This is both the local smoke test of the deployable image and the one-command way to run
the whole product.

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

## 7a. Chaos check: Redis outage (docs/08 S3-06)
Run before a release whenever the rate limiter or Redis client changed. Expected: no 5xx, `X-RateLimit-Degraded: true` while Redis is down, headers back within ~5 s of restart.
```bash
docker compose up -d && docker compose exec gateway pnpm seed      # once
export JWT_SECRET=$(grep ^JWT_SECRET= .env | cut -d= -f2-)
docker run --rm -i --add-host=host.docker.internal:host-gateway -v "$PWD/load:/scripts" \
  -e BASE_URL=http://host.docker.internal:8080 -e JWT_SECRET -e DURATION_S=30 grafana/k6 run /scripts/ratelimit.js &
sleep 10 && docker compose stop redis && sleep 10 && docker compose start redis; wait
```
The k6 summary shows `degraded_responses > 0` and `status_5xx = 0`. The same scenario runs automatically in CI as `test/chaos.integration-spec.ts` with a disposable Redis container.

## 8. Escalation (solo project)
No on-call; if the public demo is down, `fly machines restart` first, then rollback. Keep a status note in the README if it stays down > 1 day.
