# Metrics query performance (Sprint 7)

Acceptance criterion from `docs/08` S7-05: the metrics endpoints answer a 24-hour range over a
million audit rows in under 500 ms.

Reproduce with:

```bash
docker compose up -d postgres redis
pnpm --filter @omnigate/gateway build
pnpm --filter @omnigate/gateway seed:audit -- --rows 1000000 --hours 24 --truncate
pnpm --filter @omnigate/gateway seed:audit -- --measure-only     # re-measure without reseeding
```

Measured on an Apple Silicon laptop against Postgres 16 in Docker, 1,000,000 rows spread over
24 hours, warm cache. Seeding itself runs at about 61,000 rows per second.

| Query | Before | After | Budget |
|---|---|---|---|
| overview | 297 ms | 243 ms | 500 ms |
| timeseries, 1 minute buckets | 302 ms | 175 ms | 500 ms |
| breakdown by route, counts | 580 ms (combined) | 45 ms | 500 ms |
| breakdown by route, latency | see above | 42 ms | 500 ms |
| logs, 100 newest | 53 ms | 44 ms | 500 ms |
| logs, filtered to 5xx | 11 ms | 9 ms | 500 ms |

## What was slow, and why

The first implementation followed the SQL sketch in `docs/07` section 4 literally: one statement that
joined `audit_logs` to `routes`, grouped by service and computed a per-group `percentile_cont`. It
took 580 ms, over budget.

Two hypotheses were tested directly in psql rather than guessed at:

| Variant | Time |
|---|---|
| Grouped counts, no percentile | 58 ms |
| Grouped counts plus exact per-group p95 | 938 ms |
| Two percentiles over the whole window, no grouping | 183 ms |
| Grouped counts, p95 over a deterministic 10 percent sample | 86 ms |

The join was never the problem. The cost is the ordered-set aggregate: an exact percentile per group
forces a sort of every row in each group, and grouping turns one large sort into several. Rewriting
the query to aggregate before joining actually made it slower, because it changed nothing about the
sort and lost a hash aggregate.

## The fix

The breakdown endpoint now issues two cheap statements instead of one expensive one:

1. Exact counts per group, which is a fast grouped scan.
2. A p95 per group, computed from a deterministic 10 percent sample (`id % 10 = 0`) once the window
   holds more than 200,000 requests.

Sampling is adaptive, so short windows and small deployments still get an exact percentile, and the
response says which it was via `sampledLatency`. For a top-N table in a dashboard, a p95 drawn from
100,000 requests is more than accurate enough, and the endpoint now runs an order of magnitude inside
the budget.

The overview and timeseries endpoints keep exact percentiles: they aggregate over the whole window
rather than per group, which the numbers above show is comparatively cheap.

## Notes

- `audit_logs` is partitioned by month with a BRIN index on the timestamp, so a window query only
  touches the partitions it needs.
- Retention drops whole partitions rather than deleting rows, which is why the nightly maintenance
  job exists.
- The `(unrouted)` bucket in a breakdown is real traffic: requests that never matched a route, such
  as a 404 for an unknown service.
