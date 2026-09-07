# 03 · API Specification

Base URL (prod): `https://<app>.fly.dev` · Local: `http://localhost:8080`

## 1. Gateway (data plane)

### `ANY /api/{service}/{path...}`
Forwards to the upstream registered for `{service}`.

**Authentication** (one of, checked in order):
| Header | Format | Principal |
|--------|--------|-----------|
| `Authorization` | `Bearer <JWT>` — HS256 with `JWT_SECRET` or RS256 via `JWT_JWKS_URL`; claims used: `sub`, `scope`, `exp` | `{type:"user", id: sub}` |
| `X-API-Key` | `gw_live_<32 base62 chars>` | `{type:"api_key", id: key.id}` |

Routes with `auth_required: false` accept anonymous traffic; the principal becomes `{type:"anon", id: client_ip}` for rate limiting.

Implementation notes (Sprint 2):
- Credentials that are present are always validated, even on open routes; only a request with no `Authorization` and no `X-API-Key` becomes anonymous.
- A route with a non-empty `scopes` list requires an authenticated principal; anonymous requests get 401. The principal needs **at least one** of the listed scopes, otherwise 403 with `WWW-Authenticate: Bearer error="insufficient_scope"`.
- JWT claims: `sub` and `exp` are required; scopes are read from `scope` (space-delimited), `scp` or `scopes` (arrays). Clock skew tolerance is 60 s. `alg` must be `HS256` (secret) or `RS256` (JWKS); anything else is rejected.
- API keys: 401 for unknown or malformed keys, 403 for revoked or expired ones. If the credential store is unreachable and the key is not cached, the gateway answers 503 `https://gw/errors/service-unavailable` rather than letting the request through.
- 401 responses carry `WWW-Authenticate: Bearer realm="omnigate"`.

**Request headers forwarded:** everything except hop-by-hop (`Connection`, `Keep-Alive`, `Transfer-Encoding`, `Upgrade`, `Proxy-*`, `TE`, `Trailer`) and `X-API-Key`. Added: `X-Request-Id`, `X-Forwarded-For`, `X-Forwarded-Proto`, `X-Forwarded-Host`, `X-Gateway-Principal: <type>:<id>`.

**Response headers added by gateway:**
| Header | Always | Meaning |
|--------|--------|---------|
| `X-Request-Id` | yes | Correlation id |
| `X-RateLimit-Limit` | when limited | Max requests in window |
| `X-RateLimit-Remaining` | when limited | Remaining in current window |
| `X-RateLimit-Reset` | when limited | Unix seconds when oldest entry expires |
| `Retry-After` | on 429 | Seconds to wait |
| `X-Cache` | GET on cacheable route | `HIT` / `MISS` / `BYPASS` |
| `X-Anomaly-Score` | when `EXPOSE_ANOMALY_SCORE=true` (dev only) | Heuristic score |

**Status codes produced by the gateway itself** (upstream codes pass through untouched):
| Code | When | `type` |
|------|------|--------|
| 400 | Body > `MAX_BODY_BYTES` (1 MB) or malformed | `https://gw/errors/bad-request` |
| 401 | Missing/invalid credentials | `https://gw/errors/unauthorized` |
| 403 | Valid credentials, insufficient scope, revoked key, or anomaly block | `https://gw/errors/forbidden` |
| 404 | No route for `{service}` | `https://gw/errors/route-not-found` |
| 429 | Rate limit exceeded or key throttled | `https://gw/errors/rate-limited` |
| 502 | Upstream connection refused / reset | `https://gw/errors/bad-gateway` |
| 503 | Credential store unreachable during authentication | `https://gw/errors/service-unavailable` |
| 504 | Upstream timeout (`UPSTREAM_TIMEOUT_MS`, default 30000) | `https://gw/errors/gateway-timeout` |

### Error format — RFC 7807 `application/problem+json`
```json
{
  "type": "https://gw/errors/rate-limited",
  "title": "Too Many Requests",
  "status": 429,
  "detail": "Limit of 100 requests per 60s exceeded for api_key gw_live_a1b2c3d4",
  "instance": "/api/orders/v1/orders",
  "requestId": "01J8Z...",
  "retryAfter": 12
}
```

### Health
| Endpoint | 200 when | Body |
|----------|----------|------|
| `GET /healthz` | process alive | `{"status":"ok"}` |
| `GET /readyz` | Redis PING ok **and** Postgres `SELECT 1` ok | `{"status":"ok","redis":"ok","postgres":"ok","routes":12}` (503 otherwise) |

### Route config (`routes.yaml`, Phase 1; mirrored by DB rows in Phase 4)
```yaml
routes:
  - service: orders
    upstream: http://mock-upstream:3001
    strip_prefix: true            # /api/orders/x → /x
    auth_required: true
    scopes: [orders:read]         # optional; JWT scope or API-key scope must include one
    rate_limit: { window_seconds: 60, max_requests: 100 }
    cache_ttl_seconds: 30         # 0 = disabled; GET only
    anomaly_mode: async           # off | async | sync
    timeout_ms: 30000
```

## 2. Admin API (control plane) — `/admin/v1`
All endpoints require `Authorization: Bearer <admin JWT>` except `POST /auth/login`. All list endpoints support `?page=1&pageSize=50` and return `{ items, page, pageSize, total }`.

### Auth
| Method | Path | Body → Response |
|--------|------|-----------------|
| POST | `/auth/login` | `{email,password}` → `{accessToken, expiresIn}` (JWT, 12 h) |
| GET | `/auth/me` | → `{id,email}` |

### API keys
| Method | Path | Notes |
|--------|------|-------|
| GET | `/api-keys` | filters: `status`, `q` (name/prefix) |
| POST | `/api-keys` | `{name, scopes[], policyId?, expiresAt?}` → **201** `{id, prefix, rawKey}` — `rawKey` returned once |
| GET | `/api-keys/:id` | includes `lastUsedAt`, `requests24h` |
| PATCH | `/api-keys/:id` | `{name?, scopes?, policyId?, status?: "active"\|"revoked"}` |
| POST | `/api-keys/:id/rotate` | revokes old, returns new `rawKey` |
| DELETE | `/api-keys/:id` | soft delete (`status=revoked`) |

### Routes
| Method | Path | Notes |
|--------|------|-------|
| GET | `/routes` | |
| POST | `/routes` | same shape as yaml entry; validates upstream is `http(s)://` and not a private IP unless `ALLOW_PRIVATE_UPSTREAMS=true` |
| PATCH | `/routes/:id` | |
| DELETE | `/routes/:id` | |
| POST | `/routes/:id/cache/purge` | → `{deletedKeys}` |
| POST | `/routes/reload` | force registry refresh |

### Rate-limit policies
| Method | Path | Body |
|--------|------|------|
| GET | `/policies` | |
| POST | `/policies` | `{name, windowSeconds, maxRequests}` |
| PATCH | `/policies/:id` | |
| DELETE | `/policies/:id` | 409 if referenced |

### Metrics (all from `audit_logs`; see 07 for SQL)
| Method | Path | Query | Returns |
|--------|------|-------|---------|
| GET | `/metrics/overview` | `from,to` (ISO; default last 1 h) | `{requests, errorRate, p50, p95, rateLimited, cacheHitRatio, anomalies}` |
| GET | `/metrics/timeseries` | `from,to,bucket=1m\|5m\|1h,metric=requests\|errors\|latency_p95\|rate_limited\|cache_hits` | `[{ts, value}]` |
| GET | `/metrics/breakdown` | `from,to,by=route\|api_key\|status\|client_ip,limit=10` | `[{key, requests, errors, p95}]` |

### Anomalies
| Method | Path | Notes |
|--------|------|-------|
| GET | `/anomalies` | filters: `minScore`, `verdict`, `apiKeyId`, `routeId`, `reviewed`, `from`, `to` |
| GET | `/anomalies/:id` | full record incl. redacted payload sample and LLM reasoning |
| PATCH | `/anomalies/:id/review` | `{reviewed: true, label: "true_positive"\|"false_positive"}` — feeds the eval set |
| POST | `/anomalies/:id/throttle-key` | `{seconds}` sets Redis throttle flag on the key |

### Logs
| Method | Path | Notes |
|--------|------|-------|
| GET | `/logs` | filters: `from,to,status,routeId,apiKeyId,requestId,minLatencyMs`; max 1000 rows |

## 3. Versioning and compatibility
- Admin API is versioned in the path (`/admin/v1`). Gateway data plane is unversioned by design (it proxies).
- Additive changes only within v1; breaking changes bump to `/admin/v2`.
