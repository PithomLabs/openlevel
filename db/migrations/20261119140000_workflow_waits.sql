-- FIND-06: durable workflow waits. A wait step persists its continuation
-- here instead of arming an in-process timer: a delayed boss job resumes it
-- at due_at, and the boot reaper recovers rows whose job never arrives.
-- The partial unique index is the duplicate-scheduling backstop: one live
-- continuation per run, enforced by the database rather than by convention.

-- migrate:up

CREATE TABLE IF NOT EXISTS workflow_waits (
  id             text PRIMARY KEY,
  location_id    text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  run_id         text NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  workflow_id    text NOT NULL,
  contact_id     text REFERENCES contacts(id) ON DELETE SET NULL,
  trigger_type   text NOT NULL,
  from_position  int NOT NULL,
  due_at         timestamptz NOT NULL,
  definition_hash text NOT NULL,
  status         text NOT NULL DEFAULT 'pending',
  claimed_by     text,
  claimed_at     timestamptz,
  attempts       int NOT NULL DEFAULT 0,
  created_at     timestamptz DEFAULT now(),
  updated_at     timestamptz DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS waits_single_pending_per_run
  ON workflow_waits(run_id) WHERE status IN ('pending', 'claimed');

CREATE INDEX IF NOT EXISTS waits_due
  ON workflow_waits(status, due_at) WHERE status = 'pending';

-- migrate:down

DROP INDEX IF EXISTS waits_due;
DROP INDEX IF EXISTS waits_single_pending_per_run;
DROP TABLE IF EXISTS workflow_waits;
