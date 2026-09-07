# 05 · Rate Limiting & Caching Design (Phase 2)

## 1. Rate limiting

### 1.1 Policy resolution
```
policy = route.policy ?? apiKey.policy ?? DEFAULT_POLICY (env: RL_DEFAULT_WINDOW_S=60, RL_DEFAULT_MAX=100)
principal = "api_key:<id>" | "user:<sub>" | "anon:<ip>"
key = `rl:${policy.id}:${principal}`
```
Anonymous traffic is additionally capped by a global per-IP policy (`RL_ANON_MAX`, default 30/60 s) to make unauthenticated abuse cheap to stop.

### 1.2 Algorithm — sliding window log (ADR-002)
One atomic Lua call per request. Keeps exact timestamps; no boundary bursts.

Implemented in `apps/gateway/src/rate-limit/lua/sliding_window.lua`. The shipped script generalises the
single-bucket version below in two ways, both decided in Sprint 3:
- **Throttle first.** `KEYS[1]` is `throttle:{principal}`; a positive `PTTL` returns immediately, so a throttled
  principal never touches a bucket.
- **Several buckets, all-or-nothing.** `KEYS[2..n]` are the applicable buckets (the resolved policy, plus the
  global anonymous cap for anon principals). The request is recorded only if *every* bucket has room, so a denied
  request consumes nothing and one round trip covers all limits.

Single-bucket core for reference:
```lua
-- KEYS[1] = rl key
-- ARGV[1] = now_ms, ARGV[2] = window_ms, ARGV[3] = max, ARGV[4] = member (now_ms:reqId)
-- returns { allowed(0/1), remaining, reset_ms, retry_after_ms }
local key    = KEYS[1]
local now    = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local max    = tonumber(ARGV[3])
local member = ARGV[4]

redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
local count = redis.call('ZCARD', key)

if count < max then
  redis.call('ZADD', key, now, member)
  redis.call('PEXPIRE', key, window + 1000)
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local reset  = (oldest[2] and (tonumber(oldest[2]) + window)) or (now + window)
  return { 1, max - count - 1, reset, 0 }
else
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local reset  = (oldest[2] and (tonumber(oldest[2]) + window)) or (now + window)
  redis.call('PEXPIRE', key, window + 1000)
  return { 0, 0, reset, math.max(1, reset - now) }
end
```

Loaded once with `redis.defineCommand('slidingWindow', { lua })` (ioredis) so it runs via `EVALSHA`, with an
automatic `EVAL` fallback after a Redis restart.

### 1.3 Guard behaviour
```ts
// pseudo
if (await redis.exists(`throttle:${principal}`)) throw RateLimited(retryAfter = ttl);
const [allowed, remaining, resetMs, retryMs] = await redis.slidingWindow(key, now, windowMs, max, `${now}:${reqId}`);
res.set('X-RateLimit-Limit', max); res.set('X-RateLimit-Remaining', remaining);
res.set('X-RateLimit-Reset', Math.ceil(resetMs / 1000));
if (!allowed) { res.set('Retry-After', Math.ceil(retryMs / 1000)); throw RateLimited(); }
```
- **Redis error** → log `warn rate_limit.fail_open` with a 1/min sampling, allow the request, set `X-RateLimit-Degraded: true`. Auth is never skipped.
- Rate limit is evaluated **before** the cache lookup so cached responses still count (protects against cache-busting probes). Flip with `RL_COUNT_CACHE_HITS=false` if you prefer.

### 1.4 Correctness tests (see 09)
- 100 requests at max=100 → all 200; 101st → 429 with `Retry-After ≥ 1`.
- After `window` elapses, requests allowed again; `X-RateLimit-Reset` matches within ±1 s.
- 50 concurrent requests at max=10 → exactly 10 × 200, 40 × 429 (atomicity).
- Redis stopped → requests succeed with `X-RateLimit-Degraded`.

**Measured (Sprint 3, `docs/results/ratelimit-k6.txt`):** 500 rps for 60 s over 20 principals with a 100/60 s policy
through the compose stack: 30,002 requests, 2,000 × 2xx (exactly 20 × 100), 28,001 × 429 against 28,000 expected,
0 × 5xx, p95 = 1.32 ms for served requests. Chaos (`docs/results/chaos-redis-k6.txt`): Redis stopped for 10 s mid-run,
0 × 5xx, 1,113 degraded responses, reconnect ~1 s after restart.

### 1.5 v1.1 stretch — token bucket policy type
Adds `burst` and `refillPerSecond` to the policy; separate Lua script (`GET` bucket state, refill by elapsed time, `SET` with TTL). Useful for routes where short bursts are legitimate.

## 2. Response caching

### 2.1 Eligibility
Cache **only if all** hold: method `GET` or `HEAD` · route `cacheTtlSeconds > 0` · request has no `Authorization` with a user JWT **unless** route sets `cacheVaryOnPrincipal: true` (default true → per-principal cache) · no `Cache-Control: no-store` in request · upstream status is 200/203/204/301/404 · upstream `Cache-Control` does not contain `private` or `no-store` · body ≤ `CACHE_MAX_BODY_BYTES` (256 KB).

### 2.2 Key
`cache:{routeId}:{sha1(method | path | sortedQuery | principalIfVary | acceptHeader)}`

### 2.3 Flow
```
CacheInterceptor
  ├─ key = build(req)
  ├─ hit = GET key → 200 with stored headers + body, X-Cache: HIT, Age: <s>
  └─ miss → continue; on upstream response, if eligible:
        SETEX key ttl json({status, headers(subset), bodyB64}); SADD cache:idx:{routeId} key
        X-Cache: MISS
Request Cache-Control: no-cache → skip lookup, still store → X-Cache: BYPASS
```
Stored response headers whitelist: `content-type`, `content-encoding`, `etag`, `last-modified`, `cache-control`, `vary`.

### 2.4 Stampede protection (cheap version)
On MISS, `SET lock:{key} 1 NX PX 2000`; if lock not acquired, wait up to 200 ms polling `GET key` every 25 ms, then proceed to upstream anyway. Good enough for v1; document as a known limitation.

### 2.5 Purge
`POST /admin/v1/routes/:id/cache/purge` → `SMEMBERS cache:idx:{routeId}` → `UNLINK` in chunks of 500 → `DEL idx`.

### 2.6 Metrics to expose
- `cache_status` per audit row → dashboard computes hit ratio = HIT / (HIT+MISS) per route.
- Target for demo: ≥60 % on the `mock` route under the k6 read scenario.

## 3. Configuration reference (env)
| Var | Default | Notes |
|-----|---------|-------|
| `RL_DEFAULT_WINDOW_S` | 60 | |
| `RL_DEFAULT_MAX` | 100 | |
| `RL_ANON_MAX` | 30 | per IP per window |
| `RL_COUNT_CACHE_HITS` | true | |
| `RL_FAIL_OPEN` | true | set false to return 503 when Redis is down |
| `CACHE_MAX_BODY_BYTES` | 262144 | |
| `CACHE_DEFAULT_VARY_ON_PRINCIPAL` | true | |
