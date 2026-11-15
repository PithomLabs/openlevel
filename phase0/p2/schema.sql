-- P2 staging proof schema (addendum §2/§4). Staging-only.
--
-- Applied by phase0/p2/setup-staging.mjs (Neon staging) and by
-- phase0/setup-db.ts (local/CI scratch DBs, proving the file parses and
-- is idempotent on every run). All proof tables live in the `app`
-- schema per V2.1 §9 — never unqualified `public`.
--
-- Idempotent throughout (IF NOT EXISTS); safe to re-apply; destroys
-- nothing. Contains no dollar-quoted bodies (setup-staging splits on
-- semicolons and refuses the file if that ever changes).
CREATE SCHEMA IF NOT EXISTS app;

-- Probe-step evidence: every probe step writes one row; fencing
-- assertions count marks per workflow ID.
CREATE TABLE IF NOT EXISTS app.p2_probe_log (
  id          bigserial PRIMARY KEY,
  workflow_id text NOT NULL,
  mark        text NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS p2_probe_by_workflow ON app.p2_probe_log (workflow_id, mark);

-- Worker boot generations: one row per worker boot, NEVER overwritten.
-- A replacement that overwrote a single heartbeat row could conceal an
-- executor overlap; separate generations make overlap observable.
-- Timestamps are database-generated (now()) for trustworthy ordering.
CREATE TABLE IF NOT EXISTS app.p2_worker_generation (
  boot_id         text PRIMARY KEY,  -- unique per worker boot (worker-generated UUID)
  machine_id      text NOT NULL,     -- FLY_MACHINE_ID, or 'local' outside Fly
  executor_id     text NOT NULL,     -- DBOS__VMID (expected 'worker-1')
  db_user         text NOT NULL DEFAULT (session_user::text),  -- m2: proves the connected role (worker login, never migrator)
  started_at      timestamptz NOT NULL DEFAULT now(),
  last_heartbeat  timestamptz NOT NULL DEFAULT now(),
  state           text NOT NULL DEFAULT 'starting',  -- starting|ready|draining|stopped
  shutdown_at     timestamptz,       -- set on clean shutdown when available
  sysdb_latency_ms int               -- last measured sysdb round-trip, NULL if unknown
);
CREATE INDEX IF NOT EXISTS p2_generation_executor ON app.p2_worker_generation (executor_id, started_at);

-- No-overlap conservative screen (run at evidence time, not as a view).
-- Draining counts: a draining worker still executes in-flight steps, so
-- excluding it could conceal a genuine overlap. This screen CANNOT clear
-- a replacement by itself — freshness alone never retires a worker. The
-- definitive arbiter is check-fencing.mjs over a stop-verify-start
-- transcript (old Machine observed stopped BEFORE the replacement boot,
-- plus generation agreement). A row below always FAILs; no row still
-- requires the transcript guard to PASS.
--   SELECT executor_id, count(*) FROM app.p2_worker_generation
--    WHERE state IN ('starting','ready','draining')
--      AND last_heartbeat > now() - make_interval(mins => 3)
--    GROUP BY executor_id HAVING count(*) > 1;

-- Provider-side acceptance ledger: the simulated EXTERNAL effect. Written
-- by the staging fake provider in its OWN transaction, independently of
-- the application attempt record (addendum §3). Survives worker
-- termination by construction (durable rows, not files).
--
-- UNIQUE(operation_id) is the load-bearing invariant (M4): one accepted
-- provider operation per stable business operation, arbitrated by
-- PostgreSQL itself — including concurrent acceptances, where the loser
-- gets 23505 instead of a second row. Application attempts may still
-- multiply (pre-acceptance rejections/replays); only acceptance is
-- singular. Check-then-insert in application code could never provide
-- this; the constraint does.
CREATE TABLE IF NOT EXISTS app.p2_provider_ledger (
  id            bigserial PRIMARY KEY,
  operation_id  text NOT NULL,   -- stable business operation identity
  attempt_id    text NOT NULL,   -- attempt the provider accepted
  accepted_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (operation_id)
);
CREATE INDEX IF NOT EXISTS p2_ledger_by_operation ON app.p2_provider_ledger (operation_id);

-- Exactly-one-acceptance reference: exactly one row per operation_id
-- across the original execution and all recoveries, or FAIL.
