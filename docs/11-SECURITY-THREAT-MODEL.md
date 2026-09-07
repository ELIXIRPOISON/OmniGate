# 11 · Security & Threat Model

## 1. Assets
Upstream services (availability + data) · API keys and admin credentials · audit logs (contain IPs, paths, redacted samples) · LLM API key and budget · the gateway's own availability.

## 2. Trust boundaries
```
Internet ──▶ [Gateway] ──▶ Upstreams (trusted network)
                │
                ├──▶ Redis / Postgres (trusted, private network / TLS)
                └──▶ LLM provider (third party — receives redacted data only)
Dashboard (browser) ──▶ Admin API (same origin in prod)
```

## 3. Threats and controls

| ID | Threat (STRIDE) | Where | Control | Phase |
|----|-----------------|-------|---------|-------|
| T1 | Spoofing: forged JWT | Auth | Verify signature + `exp` + `iat` skew ≤ 60 s; `alg` pinned (never `none`); JWKS cached with kid rotation | 1 |
| T2 | Spoofing: API key brute force | Auth | 40-char keys (≈190 bits); prefix lookup then constant-time compare; per-IP 401 counter feeds heuristics + anon cap | 1, 3 |
| T3 | Tampering: client sets `X-Forwarded-For` / `X-Gateway-Principal` | Proxy | Strip inbound `X-Gateway-*`; trust XFF only when `TRUST_PROXY=true` and take first untrusted hop | 1 |
| T4 | Tampering: request smuggling via hop-by-hop headers | Proxy | Strip `Connection`-listed headers, `Transfer-Encoding` mismatches rejected by Node; single HTTP/1.1 upstream client | 1 |
| T5 | Information disclosure: secrets in logs | Logging | Redactor runs before any log/persist; header allow-list for logging | 1, 3 |
| T6 | Information disclosure: raw API key stored | DB | Only `sha256(pepper + key)`; raw shown once | 2 |
| T7 | Information disclosure: stack traces in responses | Errors | Problem-details filter hides internals for 5xx | 1 |
| T8 | DoS: flood | Rate limit | Sliding window + anon per-IP cap; `MAX_BODY_BYTES`; upstream timeout | 2 |
| T9 | DoS: cache poisoning / cache-busting | Cache | Key includes sorted query only; vary on principal by default; count cache hits toward limits | 2 |
| T10 | DoS: Redis exhaustion | Redis | TTL on every key; LRU eviction for cache; ZSET size bounded by `max` | 2 |
| T11 | SSRF via admin-created route pointing at metadata IP / internal service | Admin | Upstream must be `http(s)`; deny RFC1918/link-local/loopback unless `ALLOW_PRIVATE_UPSTREAMS`; admin-only endpoint | 4 |
| T12 | Elevation: dashboard admin takeover | Admin | bcrypt cost 12; separate `ADMIN_JWT_SECRET`; 12 h expiry; login rate-limited 5/min/IP; CORS locked | 4 |
| T13 | Repudiation: no trace of who did what | Audit | `request_id` everywhere; admin mutations logged with admin id (add `admin_audit` table if time — v1.1) | 4 |
| T14 | Prompt injection: payload instructs the LLM | Anomaly | Payload wrapped as data with explicit instruction; JSON-only output validated by zod; verdict only affects scoring, never executes anything | 3 |
| T15 | Data exfiltration to LLM provider | Anomaly | Redaction + truncation; `LLM_PROVIDER=local`/`fake` available; document what is sent in README | 3 |
| T16 | LLM budget abuse (attacker triggers many calls) | Anomaly | Gate + sampling + daily cap + dedup + circuit breaker | 3 |
| T17 | Fail-open abuse (kill Redis to bypass limits) | Rate limit | Redis is on a private network; `RL_FAIL_OPEN=false` option; alert log on degraded mode | 2 |
| T18 | Supply chain | Build | `pnpm audit --prod` in CI; lockfile frozen; Alpine base pinned by digest in release | 5 |
| T19 | Secrets in repo | Repo | `.env` git-ignored; `gitleaks` pre-commit hook; Fly secrets | 1 |

## 4. Secure defaults checklist (verify before M5)
- [ ] `helmet()` on admin/dashboard routes; proxied routes untouched
- [ ] HTTPS forced at the edge (`force_https`)
- [ ] `Content-Security-Policy` for the dashboard (self + inline styles from Tailwind build only)
- [ ] Admin login attempts rate-limited and logged
- [ ] Demo API key rotated after any public demo
- [ ] `EXPOSE_ANOMALY_SCORE=false` in prod
- [ ] Dependencies free of known criticals

## 5. What to say in the README's security section
Short, honest paragraph: what is enforced (auth, limits, redaction, SSRF guard), what is best-effort (async anomaly blocking, fail-open), and what is out of scope (WAF-grade rules, HA). Reviewers value candour over claims.
