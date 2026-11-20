-- R13-04: the sweeper's location discovery now covers stale `sending` rows
-- eligible for reclaim, not just `pending` rows. Widen the drain index to
-- match the shared recoverability predicate so discovery stays indexed.
-- migrate:up

DROP INDEX IF EXISTS outbox_drain;
CREATE INDEX IF NOT EXISTS outbox_drain
  ON outbox(location_id, status, available_at) WHERE status IN ('pending', 'sending');

-- migrate:down

DROP INDEX IF EXISTS outbox_drain;
CREATE INDEX outbox_drain
  ON outbox(status, available_at) WHERE status = 'pending';
