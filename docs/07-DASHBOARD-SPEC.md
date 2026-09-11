# 07 · Dashboard Specification (Phase 4)

## 1. Stack
React 18 + Vite + TypeScript · TanStack Query (10 s `refetchInterval`) · Recharts · Tailwind · React Router · zod for API response validation · Vitest + Testing Library. Types imported from `packages/shared`.

Built to `apps/dashboard/dist`, served by the gateway at `/dashboard` (ADR-005). Dev: Vite on `:5173` with proxy to `:8080/admin`.

> **Implemented in Sprint 8.** Stack as shipped: React 19 + Vite + Tailwind 4 + TanStack Query +
> Recharts + framer-motion, in a shadcn-style layout (`components/ui`, `lib/utils`, `@/*` alias).
> The visual language and every token are documented in [`13-DESIGN-SYSTEM.md`](13-DESIGN-SYSTEM.md).
>
> Deviations from the sketch below, each with a reason:
> - **The stacked 2xx/4xx/5xx chart was dropped.** Its colours fail colour-vision separation as a fill
>   set, and a stack dominated by 2xx hides the errors it exists to show. Requests, latency and
>   refusals are three single-purpose charts; the status split is a bar list.
> - **Traffic spikes** are marked with a reference band on the requests chart, as specified.
> - **The time range is a segmented control**, not a dropdown: five presets fit in one row and the
>   current range stays visible.
> - **Sparse buckets are zero-filled client-side** before charting, because the metrics API only
>   returns buckets that contain data.
> - **Auto refresh is 10 s and can be paused**, with the age of the data shown next to the control.

## 2. Information architecture
```
/login
/                → Overview
/traffic         → Traffic explorer
/anomalies       → Anomaly review
/anomalies/:id   → Detail drawer (route-addressable)
/api-keys        → Key management
/routes          → Route + policy management
/logs            → Log explorer
```
Global: time-range picker (15 m · 1 h · 6 h · 24 h · 7 d · custom), auto-refresh toggle, admin menu (logout).

## 3. Screens

### 3.1 Overview (`/`)
| Widget | Type | Source |
|--------|------|--------|
| KPI cards: Requests · Error rate · p95 latency · 429s · Cache hit ratio · Anomalies | number + delta vs previous window | `GET /metrics/overview` (called twice: current and previous range) |
| Requests per minute | `AreaChart` | `/metrics/timeseries?metric=requests` |
| Latency p50/p95 | `LineChart` two series | `/metrics/timeseries?metric=latency_p95` + `latency_p50` |
| Status code mix | stacked `BarChart` (2xx/4xx/5xx) | `/metrics/timeseries?metric=status_mix` |
| Top routes / top keys | two small tables | `/metrics/breakdown?by=route` / `by=api_key` |
| Recent anomalies (5) | list with score badge | `/anomalies?pageSize=5` |

Traffic spikes: the requests chart draws a `ReferenceArea` where a bucket exceeds 3× the median of the range (computed client-side) — this is the "visualize traffic spikes" deliverable.

### 3.2 Traffic (`/traffic`)
Filters: route, API key, status class. Charts: requests + rate-limited overlay (`ComposedChart`), cache HIT/MISS/BYPASS stacked bars per route, per-client-IP breakdown table (top 20).

### 3.3 Anomalies (`/anomalies`)
Table columns: time · score (colour badge) · verdict · categories chips · route · principal · blocked · reviewed. Filters map 1:1 to `GET /anomalies` params. Row click → drawer: envelope summary, heuristic signal bars, LLM reasoning, redacted payload sample (monospace), actions **Mark true positive / Mark false positive / Throttle key 10 min**.

### 3.4 API keys (`/api-keys`)
Table + "Create key" modal (name, scopes multi-select, policy select, expiry). On create, a one-time modal shows the raw key with copy button and a warning it won't be shown again. Row actions: rotate, revoke. Detail panel shows 24 h sparkline (`/metrics/timeseries?apiKeyId=`).

### 3.5 Routes (`/routes`)
Table of routes with inline enable/disable toggle. Create/edit form mirrors the yaml schema (upstream URL validated client-side). Buttons: purge cache, reload registry. Policies managed in a tab on the same page.

### 3.6 Logs (`/logs`)
Filter bar (time, status, route, key, request id, min latency) → virtualised table (1000 rows max) → row expands to full record. "Copy request id" and "Find anomaly" (jumps to `/anomalies?requestId=`).

## 4. Metrics SQL (Admin API side)

```sql
-- overview
SELECT count(*)                                            AS requests,
       avg((status_code >= 500)::int)                      AS error_rate,
       percentile_cont(0.5)  WITHIN GROUP (ORDER BY latency_ms) AS p50,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95,
       count(*) FILTER (WHERE rate_limited)                AS rate_limited,
       count(*) FILTER (WHERE cache_status = 'HIT')::float
         / NULLIF(count(*) FILTER (WHERE cache_status IN ('HIT','MISS')), 0) AS cache_hit_ratio
FROM audit_logs WHERE ts >= $1 AND ts < $2;

-- timeseries (bucket = '1 minute' | '5 minutes' | '1 hour')
SELECT date_bin($3::interval, ts, '2000-01-01') AS bucket,
       count(*) AS requests,
       count(*) FILTER (WHERE status_code >= 500) AS errors,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95,
       count(*) FILTER (WHERE rate_limited) AS rate_limited,
       count(*) FILTER (WHERE cache_status = 'HIT') AS cache_hits
FROM audit_logs WHERE ts >= $1 AND ts < $2
GROUP BY 1 ORDER BY 1;

-- breakdown by route
SELECT r.service AS key, count(*) AS requests,
       count(*) FILTER (WHERE status_code >= 500) AS errors,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95
FROM audit_logs a LEFT JOIN routes r ON r.id = a.route_id
WHERE ts >= $1 AND ts < $2 GROUP BY 1 ORDER BY 2 DESC LIMIT $3;
```
Ranges > 24 h: cap bucket at 1 h and add `LIMIT 2000` to keep responses small. If the 7 d query exceeds 1 s in testing, add a 5-minute rollup table (`audit_rollup_5m`) refreshed by the worker — documented stretch, not v1.

## 5. Component checklist
- `KpiCard`, `TimeRangePicker`, `ScoreBadge`, `CategoryChips`, `ProblemAlert` (renders RFC 7807 errors), `OneTimeSecretModal`, `ConfirmDialog`, `DataTable` (sortable, paginated), `SpikeAreaChart`.

## 6. Non-functional
- First contentful paint < 1.5 s on the deployed URL.
- All pages usable at 1280 px and 390 px widths.
- Every chart has an empty state ("No traffic in this range — try the k6 script in README").
- Auth: store admin JWT in memory + `sessionStorage`; 401 → redirect to `/login`.
