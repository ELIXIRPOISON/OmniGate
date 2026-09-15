# 15 · Adopting OmniGate: putting it in front of your own services

Everything else in `docs/` was written to build the gateway. This page is written to *use* it. It
assumes you have services already running somewhere and want one entry point in front of them, and
it was checked by having five different adopters follow it against the real repository.

If you only want to see the product work, the README quick start does that against a bundled mock
service in five minutes. Come back here when you want it in front of something real.

## What you are deploying

One container. It serves the data plane (`/api/{service}/...`, proxied to your upstreams), the admin
API (`/admin/v1`), the dashboard (`/`), health (`/healthz`, `/readyz`) and Prometheus (`/metrics`),
all on one port. It needs PostgreSQL and Redis. It speaks plain HTTP and does not terminate TLS.

The image is published on release as `ghcr.io/elixirpoison/omnigate:<version>` with a matching
`omnigate-migrate` image that applies database migrations and exits. Until a release exists, or if
you have changed anything, `docker compose ... up --build` builds both from the root `Dockerfile`.

## The five facts every recipe relies on

**1. A request to `/api/{service}/rest` is proxied to the upstream registered under `service`.** By
default the prefix is stripped, so `/api/orders/v1/items` reaches your service as `/v1/items`. There
is no other routing dimension in v1: no host-based routing, no path rewriting beyond the prefix.

**2. Routes come from two places, and the database wins.** Routes created in the dashboard or via
`POST /admin/v1/routes` live in PostgreSQL and take effect immediately. Routes in `routes.yaml` are
read once at boot; `POST /admin/v1/routes/reload` re-merges the database over those, it does not
re-read the file, so a file edit needs a gateway restart. A database route and a file route with
the same `service` name resolve to the database one. The image ships an **empty** `routes.yaml`; the
demo overlay swaps in `routes.demo.yaml`.

**3. The seed creates an admin and three rate-limit policies, nothing else.**
`node dist/prisma/seed.js` reads `ADMIN_EMAIL` / `ADMIN_PASSWORD`, upserts that admin, and creates the
`default` (100/min), `strict` (10/min) and `generous` (1000/min) policies. It is idempotent. Only
`--demo` adds the mock routes and a demo API key, and you never want that in a real database.

**4. Four secrets must be real before `NODE_ENV=production` boots.** `JWT_SECRET` (or a
`JWT_JWKS_URL` instead), `API_KEY_PEPPER`, `ADMIN_PASSWORD` and `ADMIN_JWT_SECRET`. The gateway refuses
to start on the values `.env.example` ships with, and on `EXPOSE_ANOMALY_SCORE=true`. Generate them
with `openssl rand -hex 32`. Rotating `API_KEY_PEPPER` later invalidates every issued API key.

**5. Anonymous callers are capped per IP on top of the route's own limit.** `RL_ANON_MAX` (default
30 per `RL_DEFAULT_WINDOW_S`) applies to every request on an open route from callers presenting no
credential, shared across all open routes. A route allowing 100/min still answers 429 to one
unauthenticated IP after 30. Authenticated callers are limited only by their key's or the route's
policy.

## Route fields

The same route expressed both ways. Only `service` and `upstream` are required.

| `routes.yaml` | `POST /admin/v1/routes` | Default | Meaning |
|---|---|---|---|
| `service` | `service` | required | URL segment; `^[a-z0-9][a-z0-9-]{0,62}$`, unique |
| `upstream` | `upstream` | required | `http://` or `https://` origin the request is proxied to |
| `strip_prefix` | `stripPrefix` | `true` | drop `/api/{service}` before forwarding |
| `methods` | `methods` | `['*']` | allowed methods; anything else is `method_mismatch` |
| `auth_required` | `authRequired` | `true` | a JWT or API key must be presented |
| `scopes` | `scopes` | `[]` | the credential must carry at least one; naming any implies auth |
| `rate_limit: {window_seconds, max_requests}` | `policyId` | route → key's policy → `RL_DEFAULT_*` | see [05](05-RATE-LIMIT-AND-CACHE.md) §1.1 for precedence |
| `cache_ttl_seconds` | `cacheTtlSeconds` | `0` (off) | GET/HEAD responses cached this long |
| `cache_vary_on_principal` | | per-caller | `false` shares one entry for public data |
| `anomaly_mode` | `anomalyMode` | `async` | `off` \| `async` \| `sync` (see below) |
| `block_on_heuristic` | | `false` | file only: 403 on an injection match scoring ≥ 0.95 |
| `timeout_ms` | `timeoutMs` | `UPSTREAM_TIMEOUT_MS` (30000) | time to upstream headers |
| | `enabled` | `true` | disabled routes answer 404 |

Upstreams that resolve to private or loopback addresses (`10.x`, `172.16-31.x`, `192.168.x`,
`127.x`, `*.internal`, `*.local`, container names) are refused unless `ALLOW_PRIVATE_UPSTREAMS=true`.
`compose.prod.yml` turns it on, because inside Docker every upstream is private. Turn it off when
your upstreams are public hostnames and you want the SSRF guard.

---

## Recipe A: one service on a VPS, behind nginx or Caddy

You have an API on the box at `127.0.0.1:4000`, currently reached through nginx. You want API keys
and rate limiting in front of it.

```bash
git clone https://github.com/ELIXIRPOISON/OmniGate && cd OmniGate
cp .env.example .env
```

Edit `.env`: replace the four secrets, set `ADMIN_EMAIL`, and add

```
TRUST_PROXY=true          # nginx will be the only thing reaching :8080
CORS_ORIGIN=https://gateway.example.com
```

Your service must listen on an address the container can reach. `127.0.0.1` inside your service means
"only this host's loopback", which the container is not on. Either bind it to `0.0.0.0` and firewall
the port, or bind it to the Docker bridge address (`docker network inspect bridge`). Then:

```bash
docker compose -f compose.prod.yml up -d              # add --build if no release image exists yet
docker compose -f compose.prod.yml exec gateway node dist/prisma/seed.js
```

Sign in at `http://127.0.0.1:8080` (tunnel it, or do this step after nginx is in front), open
**Routes → Add route**:

- service `orders`, upstream `http://host.docker.internal:4000`, authentication required.

Mint a key under **API keys**. Then in nginx, a separate server block for the gateway's hostname:

```nginx
server {
  listen 443 ssl;
  server_name gateway.example.com;
  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

Your clients now call `https://gateway.example.com/api/orders/v1/items` with `X-API-Key`. Your service
receives `/v1/items` with `X-Gateway-Principal` set and never sees an unauthenticated request. Keep
the old direct route in nginx until you have watched the dashboard for a day, then remove it.

Because `compose.prod.yml` binds 8080 to `127.0.0.1` by default, nothing reaches the gateway except
through nginx, which is what makes `TRUST_PROXY=true` safe.

## Recipe B: joining an existing docker-compose stack

You have `users`, `billing` and `catalog` as services in one `docker-compose.yml` and want a single
entry point plus the dashboard.

Add to your existing compose file, alongside your services:

```yaml
services:
  gateway:
    image: ghcr.io/elixirpoison/omnigate:latest
    ports: ['127.0.0.1:8080:8080']
    env_file: .env.omnigate
    environment:
      DATABASE_URL: postgresql://omnigate:${OMNIGATE_DB_PASSWORD}@omnigate-db:5432/omnigate
      REDIS_URL: redis://omnigate-redis:6379
      ALLOW_PRIVATE_UPSTREAMS: 'true'
      ANOMALY_ENFORCE: 'false'
    depends_on:
      omnigate-migrate: { condition: service_completed_successfully }
  omnigate-migrate:
    image: ghcr.io/elixirpoison/omnigate-migrate:latest
    environment:
      DATABASE_URL: postgresql://omnigate:${OMNIGATE_DB_PASSWORD}@omnigate-db:5432/omnigate
    depends_on:
      omnigate-db: { condition: service_healthy }
  omnigate-db:
    image: postgres:16-alpine
    environment: { POSTGRES_USER: omnigate, POSTGRES_PASSWORD: '${OMNIGATE_DB_PASSWORD}', POSTGRES_DB: omnigate }
    volumes: ['omnigate-pg:/var/lib/postgresql/data']
    healthcheck: { test: ['CMD-SHELL', 'pg_isready -U omnigate'], interval: 10s, timeout: 3s, retries: 5 }
  omnigate-redis:
    image: redis:7-alpine
    command: redis-server --maxmemory 256mb --maxmemory-policy allkeys-lru
volumes:
  omnigate-pg:
```

`.env.omnigate` holds the four secrets plus `ADMIN_EMAIL`, `NODE_ENV=production`. Because the gateway
shares your compose network, upstreams are just service names: `http://users:3000`,
`http://billing:8080`, `http://catalog:3000`.

If you would rather keep routes in version control than click them in, put them in a file and mount
it:

```yaml
    volumes: ['./gateway-routes.yaml:/app/apps/gateway/routes.yaml:ro']
```

Then `up -d`, seed, sign in, and either add the three routes in the UI or edit the file and restart
the gateway container (the file is read at boot only). Give `catalog` a `cache_ttl_seconds` and, if its data is the same for every
caller, `cache_vary_on_principal: false`.

## Recipe C: flag first, enforce later

You run a public API that is probed constantly and you will not deploy anything that can refuse
legitimate traffic until you have watched it.

`compose.prod.yml` already starts in observe-only mode: `ANOMALY_ENFORCE=false`. In that state every
request is still scored, every suspicious one is still recorded and shows up under **Anomalies**, and
**nothing is refused** regardless of any route's `anomaly_mode`, `block_on_heuristic` or the reactive
throttle. Leave it that way and use the dashboard for a week or two.

What you are looking at, and what each thing means:

- The inline pass scores every request from nine signals and combines them with noisy-OR. Requests at
  or above `ANOMALY_GATE_THRESHOLD` (0.4) are recorded and, if a model is configured, classified after
  the response. The strongest signal is the learned route schema: a parameter name the route has never
  legitimately accepted.
- **Learned schema safety rules.** The schema is silent on a route until it has seen
  `SCHEMA_WARMUP_REQUESTS` (500) successful, unremarkable requests, and a new parameter name only
  becomes "known" after `SCHEMA_PROMOTE_PRINCIPALS` (3) distinct callers have used it successfully. So
  the first two weeks are also the schema learning your traffic.
- Measured against real traffic (CSIC 2010, [results](results/anomaly-eval-csic.md)): recall 0.494 at
  precision 1.000 with the defaults, zero false positives in 36,000 benign requests. Real APIs are
  larger than that benchmark's, so expect *some* false positives, and mark them as such in the review
  drawer.

When you are ready to enforce, exactly three things can turn a finding into a refusal, and all three
stay inert until `ANOMALY_ENFORCE=true`:

| Mechanism | Where | What it does |
|---|---|---|
| `anomaly_mode: sync` on a route | route | awaits the classification up to `LLM_TIMEOUT_SYNC_MS` (800 ms); combined score ≥ `ANOMALY_BLOCK_THRESHOLD` (0.9) answers 403; timeout or error allows |
| `block_on_heuristic: true` on a file route | route | 403 immediately when an injection pattern matched and the heuristic score is ≥ 0.95, no model involved |
| `ANOMALY_AUTO_THROTTLE=true` | global | a principal with 3 events scoring ≥ 0.7 in 5 minutes is throttled (429) for 10 minutes |

Enable them in that order of confidence: `ANOMALY_ENFORCE=true` with `block_on_heuristic` on the
routes that take user input, watch, then consider `sync` only where a model with sub-second latency
is configured. A local 7B model classifies in about 1.3 s and will never make the 800 ms budget, so
`sync` there is a no-op that fails open. `SCHEMA_VALUE_SHAPES=true` roughly doubles recall and costs
precision; the numbers are in the results page.

## Recipe D: JWTs from your identity provider

Your users already get tokens from Auth0, Keycloak, Cognito, Entra or similar, and you want the
gateway to accept those instead of, or as well as, API keys.

```
JWT_JWKS_URL=https://your-tenant.example.com/.well-known/jwks.json
JWT_ISSUER=https://your-tenant.example.com/
JWT_AUDIENCE=omnigate-api
# JWT_SECRET may be left unset when JWT_JWKS_URL is set
```

Set all three. The JWKS alone proves a token was signed by your provider; most providers sign tokens
for many applications with the same keys, and without `JWT_AUDIENCE` every one of those tokens is a
valid credential here. The gateway pins RS256 for JWKS tokens and HS256 for `JWT_SECRET` tokens by
the `alg` header, tolerates 60 s of clock skew, and requires `sub` and `exp`.

Scopes are read from a space-delimited `scope` claim, or an array in `scp` or `scopes`. A route with
`scopes: [orders:read]` requires one of those claims to contain it. If your provider puts roles
somewhere else, that is not configurable in v1; use API keys for those callers or map claims in the
provider.

Both `JWT_SECRET` and `JWT_JWKS_URL` may be set at once, in which case each token is verified against
whichever matches its algorithm.

## Recipe E: a PaaS with managed Postgres and Redis, no compose

Railway, Render, Fly and similar build the root `Dockerfile` or pull the image, give you a
`DATABASE_URL` and a `REDIS_URL`, and run one container. There is no compose, so two things the compose
files normally do become yours.

**Migrations.** The runtime image deliberately does not contain the Prisma CLI, so a "release command"
inside it cannot migrate. Run the migrate image against the managed database from anywhere Docker
runs, before each deploy that includes a migration:

```bash
docker run --rm -e DATABASE_URL='postgresql://...' ghcr.io/elixirpoison/omnigate-migrate:latest
```

or from a checkout, `DATABASE_URL='postgresql://...' pnpm --filter @omnigate/gateway prisma:migrate:deploy`.
Platforms that can run a pre-deploy job from a second image target can point it at `--target migrate`.

**Seeding.** Once, from a shell in the running container or a one-off job with the same env:
`node dist/prisma/seed.js`. It needs `ADMIN_EMAIL`, `ADMIN_PASSWORD` and `API_KEY_PEPPER`.

**Environment**, minimum (these are the gateway's own names; `compose.prod.yml` additionally accepts
`MANAGED_DATABASE_URL` / `MANAGED_REDIS_URL` so a developer's host-side `.env` cannot leak into the
containers):

```
NODE_ENV=production
PORT=8080                       # or whatever the platform injects
DATABASE_URL=...                # managed
REDIS_URL=...                   # managed; rediss:// is fine
JWT_SECRET=...                  # or JWT_JWKS_URL + JWT_ISSUER + JWT_AUDIENCE
API_KEY_PEPPER=...
ADMIN_EMAIL=you@example.com
ADMIN_PASSWORD=...
ADMIN_JWT_SECRET=...
TRUST_PROXY=true                # the platform's edge terminates TLS
CORS_ORIGIN=https://gateway.yourdomain.example
ALLOW_PRIVATE_UPSTREAMS=true    # if your upstreams are on the platform's private network
ANOMALY_ENFORCE=false           # until you have watched it
```

Health check path `/readyz`. Your upstream is whatever the platform's private DNS calls it,
`http://orders.railway.internal:3000` and the like, added as a route after you sign in.

---

## Putting it on the internet

- The gateway does not terminate TLS. Something in front does: Caddy, nginx, the platform edge.
- Bind 8080 to loopback or a private network. `compose.prod.yml` does this by default (`BIND`).
- Only then set `TRUST_PROXY=true`. With it on and 8080 reachable directly, a client sets its own
  `X-Forwarded-For` and every per-IP control, including the admin login throttle, stops working.
- `CORS_ORIGIN` matters only if you host the dashboard somewhere other than the gateway. Served from
  the gateway, it needs no CORS; the setting exists for the split case and covers `/admin` only.
- `/metrics` is hidden in production unless `METRICS_TOKEN` is set; scrape with
  `Authorization: Bearer <token>`.
- The control plane shares the port with the data plane and is protected by the admin login. If you
  want it unreachable from the public internet, deny `/admin` and `/` at the reverse proxy for
  non-office addresses; the data plane under `/api` is unaffected.

## Operating it

- **Upgrades.** Pull the new images, run the migrate image, restart the gateway. Migrations are
  forward-only and additive so far; the CHANGELOG says when one is not.
- **Multiple replicas.** Rate limits, cache, sender statistics and learned schemas all live in Redis,
  so replicas agree. The BullMQ worker runs in-process (`WORKER_INLINE=true`); every replica processes
  jobs, which is fine, and there is no separate worker deployment in v1.
- **Redis down.** Auth still works. Rate limiting and cache fail open and responses carry
  `X-RateLimit-Degraded: true`; set `RL_FAIL_OPEN=false` to answer 503 instead. Learned schemas read as
  empty and go silent rather than alerting.
- **Model down or slow.** The request is allowed and the event is recorded with the heuristic score.
- **Audit volume.** About 377 MB per million requests in PostgreSQL, partitioned by month and dropped
  after `LOG_RETENTION_DAYS` (30). There is no sampling of successful requests in v1.
- **Redis sizing.** `allkeys-lru` is right for the cache, but if Redis is undersized it will also evict
  rate-limit windows and learned schemas, which shortens windows silently. Size it above the hot set.

## What it does not do

Stated in one place so you do not have to infer it.

- No TLS termination, no HTTP/2 or HTTP/3 to upstreams, no WebSockets, no gRPC.
- No host-based routing and no path rewriting beyond stripping `/api/{service}`.
- No multi-tenancy: one admin login, one set of routes.
- No configurable JWT claim mapping beyond `scope` / `scp` / `scopes`; no OAuth flows of its own.
- No service discovery; upstreams are URLs you type.
- No token bucket; the limiter is a sliding window.
- The behavioural anomaly signals (enumeration, credential stuffing) are measured only on a synthetic
  dataset. The payload and schema signals are measured on real traffic. See
  [14-RETRO](14-RETRO.md) for the honest state.
