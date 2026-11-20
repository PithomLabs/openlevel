-- FIND-07: stable event identity, request idempotency, and dispatch outbox.
-- processed_events: delivery dedup — one row per logical event sighted.
-- idempotency_keys: HTTP retry safety — (tenant, operation, key) with a
--   payload hash; same key + different payload is a conflict, never reuse.
-- outbox: transactional dispatch intents, drained by the relay sweeper.
-- recipients_campaign_contact: one outcome row per (campaign, contact) so
--   crash recovery resumes instead of double-sending.

-- migrate:up

CREATE TABLE IF NOT EXISTS processed_events (
  location_id  text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  event_id     text NOT NULL,
  workflow_id  text NOT NULL,
  trigger_type text NOT NULL,
  created_at   timestamptz DEFAULT now(),
  PRIMARY KEY (location_id, event_id, workflow_id)
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  location_id  text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  operation    text NOT NULL,
  key          text NOT NULL,
  payload_hash text NOT NULL,
  status       text NOT NULL DEFAULT 'in_progress',
  result       jsonb,
  created_at   timestamptz DEFAULT now(),
  updated_at   timestamptz DEFAULT now(),
  PRIMARY KEY (location_id, operation, key)
);

CREATE TABLE IF NOT EXISTS outbox (
  id           text PRIMARY KEY,
  location_id  text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  aggregate    text NOT NULL,
  aggregate_id text NOT NULL,
  event        text NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}',
  status       text NOT NULL DEFAULT 'pending',
  attempts     int NOT NULL DEFAULT 0,
  available_at timestamptz DEFAULT now(),
  created_at   timestamptz DEFAULT now(),
  updated_at   timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS outbox_drain
  ON outbox(status, available_at) WHERE status = 'pending';

CREATE UNIQUE INDEX IF NOT EXISTS recipients_campaign_contact
  ON campaign_recipients(location_id, campaign_id, contact_id)
  WHERE contact_id IS NOT NULL;

-- migrate:down

DROP INDEX IF EXISTS recipients_campaign_contact;
DROP TABLE IF EXISTS outbox;
DROP TABLE IF EXISTS idempotency_keys;
DROP TABLE IF EXISTS processed_events;
