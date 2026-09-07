# 04 · Data Model

## 1. Entity overview

```
admin_users 1───* (sessions are stateless JWTs)
rate_limit_policies 1───* api_keys
rate_limit_policies 1───* routes
api_keys 1───* audit_logs ───1 routes
audit_logs 1───0..1 anomaly_events
```

## 2. Prisma schema (`apps/gateway/prisma/schema.prisma`)

```prisma
generator client { provider = "prisma-client-js" }
datasource db { provider = "postgresql"; url = env("DATABASE_URL") }

enum KeyStatus     { active revoked }
enum AnomalyMode   { off async sync }
enum Verdict       { benign suspicious malicious }
enum ReviewLabel   { true_positive false_positive }

model AdminUser {
  id           String   @id @default(uuid())
  email        String   @unique
  passwordHash String
  createdAt    DateTime @default(now())
  @@map("admin_users")
}

model RateLimitPolicy {
  id            String   @id @default(uuid())
  name          String   @unique
  windowSeconds Int
  maxRequests   Int
  apiKeys       ApiKey[]
  routes        Route[]
  createdAt     DateTime @default(now())
  @@map("rate_limit_policies")
}

model ApiKey {
  id         String    @id @default(uuid())
  name       String
  prefix     String    @unique          // "gw_live_a1b2c3d4"
  keyHash    String    @unique          // sha256(pepper + raw)
  scopes     String[]  @default([])
  status     KeyStatus @default(active)
  policy     RateLimitPolicy? @relation(fields: [policyId], references: [id])
  policyId   String?
  lastUsedAt DateTime?
  expiresAt  DateTime?
  createdAt  DateTime  @default(now())
  anomalies  AnomalyEvent[]
  @@index([status])
  @@map("api_keys")
}

model Route {
  id               String      @id @default(uuid())
  service          String      @unique   // path segment after /api/
  upstream         String
  stripPrefix      Boolean     @default(true)
  methods          String[]    @default(["*"])
  authRequired     Boolean     @default(true)
  scopes           String[]    @default([])
  policy           RateLimitPolicy? @relation(fields: [policyId], references: [id])
  policyId         String?
  cacheTtlSeconds  Int         @default(0)
  anomalyMode      AnomalyMode @default(async)
  timeoutMs        Int         @default(30000)
  enabled          Boolean     @default(true)
  createdAt        DateTime    @default(now())
  updatedAt        DateTime    @updatedAt
  anomalies        AnomalyEvent[]
  @@map("routes")
}

model AnomalyEvent {
  id              String      @id @default(uuid())
  requestId       String      @db.VarChar(64)
  apiKey          ApiKey?     @relation(fields: [apiKeyId], references: [id])
  apiKeyId        String?
  route           Route?      @relation(fields: [routeId], references: [id])
  routeId         String?
  clientIp        String?
  method          String
  path            String
  heuristicScore  Float
  llmScore        Float?
  verdict         Verdict?
  categories      String[]    @default([])   // sqli, xss, traversal, scraping, credential_stuffing, ...
  reasoning       String?
  model           String?
  llmLatencyMs    Int?
  payloadSample   String?     @db.VarChar(2000)  // redacted, truncated
  blocked         Boolean     @default(false)
  reviewed        Boolean     @default(false)
  reviewLabel     ReviewLabel?
  createdAt       DateTime    @default(now())
  @@index([createdAt])
  @@index([apiKeyId, createdAt])
  @@index([llmScore])
  @@map("anomaly_events")
}
```

## 3. Audit log — raw SQL migration (ADR-004)

`prisma/migrations/<ts>_audit_logs/migration.sql`:

```sql
CREATE TABLE audit_logs (
  id            BIGSERIAL,
  ts            TIMESTAMPTZ NOT NULL DEFAULT now(),
  request_id    VARCHAR(64) NOT NULL,
  api_key_id    UUID,
  route_id      UUID,
  principal     VARCHAR(80),           -- "api_key:<id>" | "user:<sub>" | "anon:<ip>"
  method        VARCHAR(10) NOT NULL,
  path          TEXT NOT NULL,
  status_code   SMALLINT NOT NULL,
  latency_ms    INTEGER NOT NULL,      -- total, as seen by client
  upstream_ms   INTEGER,               -- time spent waiting on upstream
  client_ip     INET,
  user_agent    VARCHAR(512),
  req_bytes     INTEGER,
  res_bytes     INTEGER,
  rate_limited  BOOLEAN NOT NULL DEFAULT false,
  cache_status  VARCHAR(8),            -- HIT | MISS | BYPASS | NULL
  anomaly_score REAL,                  -- heuristic score
  error_type    VARCHAR(64),           -- problem type slug when gateway produced the error
  PRIMARY KEY (id, ts)
) PARTITION BY RANGE (ts);

-- One partition per month; create next month's partition in a nightly job.
CREATE TABLE audit_logs_2026_09 PARTITION OF audit_logs
  FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE audit_logs_2026_10 PARTITION OF audit_logs
  FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE audit_logs_2026_11 PARTITION OF audit_logs
  FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');

CREATE INDEX audit_logs_ts_brin   ON audit_logs USING BRIN (ts);
CREATE INDEX audit_logs_key_ts    ON audit_logs (api_key_id, ts DESC);
CREATE INDEX audit_logs_route_ts  ON audit_logs (route_id, ts DESC);
CREATE INDEX audit_logs_req_id    ON audit_logs (request_id);
CREATE INDEX audit_logs_status_ts ON audit_logs (status_code, ts DESC) WHERE status_code >= 400;
```

**Batch insert (worker):** `INSERT INTO audit_logs (...) SELECT * FROM unnest($1::timestamptz[], $2::varchar[], ...)` — one statement per batch of ≤500 rows.

**Retention:** nightly job `DROP TABLE audit_logs_<yyyy_mm>` for partitions older than `LOG_RETENTION_DAYS` (30). Same job pre-creates the next month.

## 4. Seed data (`prisma/seed.ts`)
- Admin user from `ADMIN_EMAIL` / `ADMIN_PASSWORD` env (bcrypt, cost 12).
- Policies: `default` (100/60 s), `strict` (10/60 s), `generous` (1000/60 s).
- Routes: `mock` → `http://mock-upstream:3001` (auth off, cache 15 s), `orders` → same upstream (auth on, scope `orders:read`, anomaly `sync`).
- One demo API key printed to stdout once.

## 5. Redis key design

| Key | Type | TTL | Used by |
|-----|------|-----|---------|
| `rl:{policyId}:{principal}` | ZSET (score = ms timestamp, member = `ts:reqId`) | window + 1 s | RateLimitGuard |
| `throttle:{principal}` | STRING `"1"` | seconds set by anomaly policy / admin | RateLimitGuard (checked before ZSET) |
| `cache:{routeId}:{sha1(method+path+query+vary)}` | STRING (JSON `{status, headers, bodyB64}`) | route `cacheTtlSeconds` | CacheInterceptor |
| `cache:idx:{routeId}` | SET of cache keys | none (pruned on purge) | purge by route |
| `key:{prefix}` | HASH `{id, keyHash, status, scopes, policyId, expiresAt}` | 60 s | AuthGuard (read-through cache of `api_keys`) |
| `routes:changed` | pub/sub channel | — | registry refresh |
| `bull:audit:*`, `bull:anomaly:*` | BullMQ internals | — | worker |
| `cb:llm` | STRING failure counter / open flag | 60 s | LLM circuit breaker |

**Memory estimate:** 1,000 active principals × 1,000 max entries × ~100 B ≈ 100 MB worst case; typical <10 MB. Cache bounded by `maxmemory-policy allkeys-lru` on the Redis instance.

## 6. Migration policy
- All schema changes via `prisma migrate dev` locally, `prisma migrate deploy` in CI/deploy.
- Never edit a deployed migration; add a new one.
- The audit partition job is idempotent (`CREATE TABLE IF NOT EXISTS`).
