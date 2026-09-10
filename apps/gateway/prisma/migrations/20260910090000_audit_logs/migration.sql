-- audit_logs is deliberately outside the Prisma schema (ADR-004): it is the one high-volume table,
-- it is partitioned by month, and it is written with multi-row inserts rather than the ORM.
CREATE TABLE IF NOT EXISTS audit_logs (
  id            BIGSERIAL,
  ts            TIMESTAMPTZ NOT NULL DEFAULT now(),
  request_id    VARCHAR(64) NOT NULL,
  api_key_id    UUID,
  route_id      UUID,
  principal     VARCHAR(80),           -- "api_key:<id>" | "user:<sub>" | "anon:<ip>"
  method        VARCHAR(10) NOT NULL,
  path          TEXT NOT NULL,
  status_code   SMALLINT NOT NULL,
  latency_ms    INTEGER NOT NULL,      -- total, as seen by the client
  upstream_ms   INTEGER,               -- time spent waiting on the upstream
  client_ip     INET,
  user_agent    VARCHAR(512),
  req_bytes     INTEGER,
  res_bytes     INTEGER,
  rate_limited  BOOLEAN NOT NULL DEFAULT false,
  cache_status  VARCHAR(8),            -- HIT | MISS | BYPASS | NULL
  anomaly_score REAL,                  -- heuristic score
  error_type    VARCHAR(64),           -- problem type slug when the gateway produced the error
  PRIMARY KEY (id, ts)
) PARTITION BY RANGE (ts);

-- Monthly partitions. The nightly maintenance job creates the next one and drops expired ones;
-- this block seeds the previous, current and next two months so a fresh database can accept writes.
DO $$
DECLARE
  m date := date_trunc('month', now())::date - interval '1 month';
  i int;
  part text;
BEGIN
  FOR i IN 0..3 LOOP
    part := 'audit_logs_' || to_char(m, 'YYYY_MM');
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF audit_logs FOR VALUES FROM (%L) TO (%L)',
      part, m, (m + interval '1 month')::date
    );
    m := (m + interval '1 month')::date;
  END LOOP;
END $$;

CREATE INDEX IF NOT EXISTS audit_logs_ts_brin   ON audit_logs USING BRIN (ts);
CREATE INDEX IF NOT EXISTS audit_logs_key_ts    ON audit_logs (api_key_id, ts DESC);
CREATE INDEX IF NOT EXISTS audit_logs_route_ts  ON audit_logs (route_id, ts DESC);
CREATE INDEX IF NOT EXISTS audit_logs_req_id    ON audit_logs (request_id);
CREATE INDEX IF NOT EXISTS audit_logs_status_ts ON audit_logs (status_code, ts DESC) WHERE status_code >= 400;
