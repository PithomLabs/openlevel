-- N5/N15: controlled outbound sink for staging. When APP_ENV=staging, the
-- messaging resolvers return the sink instead of real provider adapters, so
-- no staging process can reach a real recipient: every would-be send lands
-- here, addressed only to STAGING_SINK_ALLOWLIST recipients (fail-closed when
-- the allowlist is absent). Operators audit staging sends by reading this
-- table; nothing here ever leaves the database.
-- migrate:up

CREATE TABLE IF NOT EXISTS outbound_sink (
  id          text PRIMARY KEY,
  location_id text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  channel     text NOT NULL,
  recipient   text NOT NULL,
  subject     text,
  body        text NOT NULL,
  created_at  timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sink_by_location
  ON outbound_sink(location_id, created_at DESC);

-- migrate:down

DROP INDEX IF EXISTS sink_by_location;
DROP TABLE IF EXISTS outbound_sink;
