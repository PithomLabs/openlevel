# P2 Staging Acceptance — executable procedure (Gate D)

> Classification: INFRASTRUCTURE PROOF. This package proves Fly/DBOS
> deployment, fencing, and recovery mechanics with an isolated probe
> application. The OpenLevel product still runs pg-boss and has no DBOS
> worker — a P2 PASS must never be represented as product DBOS-integration
> or production-readiness proof.

Execution requires a SEPARATE explicit owner authorization. No step here
runs as part of the readiness assignment.

## 0. Prerequisites and secrets (names only — never values)

- `flyctl` installed and authenticated (`fly auth whoami`).
- Neon staging project + branch (disposable; production untouched).
- Secret names (values set via `fly secrets set`, never pasted anywhere).
  The worker connects as a LOGIN role holding the runtime grants — never
  as the migrator/owner (m2: least privilege is implemented, not claimed).
  - `P2_SYSTEM_DATABASE_URL` — Neon DIRECT endpoint (DBOS system database).
  - `P2_APPLICATION_DATABASE_URL` — Neon direct endpoint for the main
    acceptance; the T6 pooled variant uses the `-pooler` endpoint.
- CLI tools on the operator machine: `node >= 22`, `psql`, `jq`.

## 1. One-time staging setup (operator machine, before first deploy)

```bash
cd /Users/sherwin/Documents/openlevel/openlevel  # or the published checkout
# Migrator credentials (Neon branch owner works; DDL on app + dbos).
export P2_SYSTEM_DATABASE_URL='postgres://<migrator>...@<neon-host>/stagedb?sslmode=require'
export P2_APPLICATION_DATABASE_URL='postgres://<migrator>...@<neon-host>/stagedb?sslmode=require'
node phase0/p2/setup-staging.mjs --confirm-db stagedb --app-role app
# Expect: both versions printed, dbos migrated (runtime grants to app),
# app schema applied, role + CONNECT + DML grants applied,
# "app proof tables present: p2_probe_log, p2_provider_ledger,
# p2_worker_generation, p3_attempt, p3_operation, p3_settlement, p3_wallet".

# Worker login role (Neon console: Roles → new role WITH LOGIN; note the
# generated password once, straight into fly secrets below — never chat):
psql "$P2_APPLICATION_DATABASE_URL" -c 'GRANT "app" TO "<worker-login-role>";'
# Verify least privilege is EFFECTIVE (act as the role, then prove a
# forbidden write fails and allowed reads succeed):
psql "$P2_APPLICATION_DATABASE_URL" -c "SET ROLE \"<worker-login-role>\"; SELECT has_table_privilege('app.p3_attempt','INSERT'), has_table_privilege('app.p2_provider_ledger','SELECT');"  # expect t,t
psql "$P2_APPLICATION_DATABASE_URL" -c 'SET ROLE "<worker-login-role>"; CREATE TABLE app.should_fail(x int);'  # expect permission denied
# From here on, ALL worker/operator URLs use the login role — the migrator
# credential never leaves this section.
```

## 2. Deploy (staging app `openlevel-p2-staging`, region `iad` disposable)

```bash
# Re-export with the WORKER LOGIN role (NOT the migrator from §1):
export P2_SYSTEM_DATABASE_URL='postgres://<worker-login-role>...@<neon-host>/stagedb?sslmode=require'
export P2_APPLICATION_DATABASE_URL='postgres://<worker-login-role>...@<neon-host>/stagedb?sslmode=require'
fly launch --no-deploy --name openlevel-p2-staging --region iad \
  --dockerfile phase0/p2/Dockerfile.p2staging  # first time only; reuse after
fly secrets set P2_SYSTEM_DATABASE_URL="$P2_SYSTEM_DATABASE_URL" \
  P2_APPLICATION_DATABASE_URL="$P2_APPLICATION_DATABASE_URL"
fly deploy --config phase0/p2/fly.staging.toml
fly scale count worker=1 web=1 --config phase0/p2/fly.staging.toml
fly status  # expect exactly 1 worker + 1 web Machine
fly secrets list  # expect NO DBOS__VMID anywhere
```

## 3. T1 — identity and startup safety

T1 negatives are unit-proven (`boot-worker.test.ts`); the positive case is
CI-proven (`p2-boot-proof` job). On staging, verify the real init:

```bash
TAG=t1-$(date +%s)
fly logs --config phase0/p2/fly.staging.toml | grep '"boot":"worker"'
# Expect exactly one line with "vmid":"worker-1".
fly ssh console --config phase0/p2/fly.staging.toml \
  -C "node phase0/p2/enqueue-probes.mjs generations --executor worker-1"
# Expect exactly one generation, state ready, fresh heartbeat.
psql "$P2_APPLICATION_DATABASE_URL" -tAc \
  "SELECT DISTINCT db_user FROM app.p2_worker_generation WHERE executor_id = 'worker-1'"
# Expect exactly the worker login role — never the migrator/owner (m2 proof).
```

Evidence: boot log line, generation row (+ db_user), `fly status` (1 worker).
Negative cases on staging (each must exit 2 with zero executor init):
temporarily set `ROLE=bogus` / unset each URL / set conflicting
`DBOS__VMID` / unset `P2_WORKER_ENTRY` on a CLONED machine
(`fly machine clone` then `fly machine destroy` it after) — never mutate
the proof worker for negative tests.

## 4. T2a — rolling deploy integrity (observed, NOT fencing)

Rolling proves previously completed work survives a deployment. It says
nothing about executor exclusion (rolling does not cordon).

```bash
TAG=t2a-$(date +%s)
fly ssh console -C "node phase0/p2/enqueue-probes.mjs enqueue --workflow normal --tag $TAG"
fly ssh console -C "node phase0/p2/enqueue-probes.mjs enqueue --workflow uncertain --tag $TAG"
# Wait for both SUCCESS (uncertain leaves a quarantined attempt by design).
fly deploy --config phase0/p2/fly.staging.toml
fly status --watch  # capture all Machine transitions with timestamps
```

Acceptance: step marks exactly step-1 + step-2 (no re-execution);
uncertain attempt still `uncertain`, operation unrefunded; replacement
generation `ready`; web `/health` green throughout.

## 5. T2b — executor fencing via stop-verify-start (the fencing proof)

```bash
TAG=t2b-$(date +%s)
# Hold windows live on the WORKER: set both, wait for a fresh generation.
fly secrets set P2_NORMAL_HOLD_MS=120000 P2_PROVIDER_DELAY_MS=120000 --config phase0/p2/fly.staging.toml
fly ssh console -C "node phase0/p2/enqueue-probes.mjs enqueue --workflow normal --tag $TAG"
fly ssh console -C "node phase0/p2/enqueue-probes.mjs enqueue --workflow provider --tag $TAG"
fly ssh console -C "node phase0/p2/enqueue-probes.mjs enqueue --workflow uncertain --tag $TAG"
# Wait for the uncertain workflow to complete (quarantine staged).
# PRECONDITION GATE — aborts exit 3 (NOT EXERCISED) unless both workflows
# are genuinely in flight. Do not proceed on any other outcome:
node phase0/p2/check-inflight.mjs --tag $TAG
# On NOT EXERCISED (i-R3): while EITHER hold window is still open, fix the
# named condition (usually: wait for dispatch/acceptance to land) and
# re-run ONLY the gate — never re-enqueue under the same tag (deterministic
# workflow IDs would collide with the first attempt). If a hold expired
# (workflows completed), establish completion (normal SUCCESS marks) or
# quarantine (uncertain attempt + ledger evidence) for the record, then
# start over with a FRESH tag. Skipping the gate invalidates the run.
# Stop-verify-start (timestamps in UTC ISO throughout):
OLD=$(fly machine list --json | jq -r '.[] | select(.config.process_group=="worker") | .id')
fly machine stop $OLD
fly machine status $OLD --watch  # wait until state == stopped; record stopped_at
# VERIFY before starting anything: old generation must read stopped (or
# go stale — then wait out the 3-minute freshness window first):
fly ssh console -C "node phase0/p2/enqueue-probes.mjs generations --executor worker-1"
fly machine start $OLD            # same-machine replacement (new boot_id)
# ... wait for the replacement generation ready ...
# Assemble /tmp/fencing-$TAG.json with EXACTLY these fields (m-R1):
# - oldMachine: { id, transitions: [{state, at}] } — from
#   `fly machine status --json` (Fly clock; supporting evidence).
# - replacement: { bootId, machineId, executorId, startedAt } — bootId
#   and startedAt from the generation row / boot log line (DB clock).
# - generations: [{ boot_id, machine_id, executor_id, started_at_ms,
#   last_heartbeat_ms, state, shutdown_at_ms }] — from
#   `generations --executor worker-1` (DB clock).
# - events: the collector's OWN ordered observations (operator-shell
#   clock via `date -u +%FT%TZ`), exactly:
#     1 stop-requested               (source: operator, machineId: old)
#     2 machine-stopped              (source: fly machine status, machineId: old)
#     3 generation-inactive-verified (source: generations query, machineId: old)
#     4 replacement-start-requested  (source: operator, machineId: new)
#     5 replacement-ready-observed   (source: generations query, machineId: new, bootId: new)
#   Strict ordering is judged ONLY on this single-collector sequence —
#   Fly and DB timestamps are never compared against each other.
node phase0/p2/check-fencing.mjs --transcript /tmp/fencing-$TAG.json
```

The guard enforces: event sequence valid (order, monotonic clock, IDs),
old stopped observed with agreeing machine evidence, replacement
requested strictly after the observed stop, old generation retired,
replacement recorded, ready, and machine-consistent. A PASS here — not
the deploy itself — is the fencing evidence.

Acceptance (all required): transcript guard PASS; replacement `ready`;
provider op exactly one ledger row with recovery probe green
(`recover --tag $TAG --op <id>`, then `check-recovery.mjs --op <id>
--tag $TAG --expect-recovery 1`); uncertain attempt still quarantined;
normal workflow completes exactly once (step-1 + step-2, no duplicates).
Afterwards: `fly secrets unset P2_NORMAL_HOLD_MS P2_PROVIDER_DELAY_MS`.

## 6. T3 — forced replacement (SIGKILL-equivalent)

```bash
TAG=t3-$(date +%s)
# Kill window lives on the WORKER (it reads P2_PROVIDER_DELAY_MS), so set
# it as a secret first (redeploys; wait for the worker generation ready):
fly secrets set P2_PROVIDER_DELAY_MS=60000 --config phase0/p2/fly.staging.toml
# ... wait for fresh ready generation ...
fly ssh console -C "node phase0/p2/enqueue-probes.mjs enqueue --workflow provider --tag $TAG"
# (Enqueue returns at once; the WORKER holds the dispatch open. Confirm
# dispatch mark present, then kill mid-hold:)
fly machine kill <worker-machine-id>   # twice: once mid-normal-step, once mid-provider-hold
# Wait for on-failure restart + recovery, then:
fly ssh console -C "node phase0/p2/enqueue-probes.mjs recover --tag $TAG --op <id>"
node phase0/p2/check-recovery.mjs --op <id> --tag $TAG --expect-recovery 1
# Afterwards: fly secrets unset P2_PROVIDER_DELAY_MS (restores delay 0)
```

Acceptance: pending workflows recovered under preserved op identity;
exactly one ledger acceptance; no second attempt dispatched blindly;
heartbeat gap visible then fresh on the new generation. The killed
generation keeps its last `ready` heartbeat frozen in time — overlap
evaluation applies the 3-minute freshness rule, so it reads as inactive
once stale (i2); never interpret the frozen row as a live executor.
A clean SIGTERM restart alone does NOT satisfy T3.

## 7. T4 — graceful shutdown and restart behavior

```bash
# 6a. SIGTERM drain (via ssh; find the worker PID first):
fly ssh console -C "ps aux | grep '[b]oot-worker'"
fly ssh console -C "kill -TERM <worker-pid>"
# Expect: dequeue stops, in-flight steps reach safe points, pools close,
# process exits 0 well under 120s; generation row -> stopped + shutdown_at.
# Record the actual exit latency from the logs.

# 6b. Crash-loop restart policy:
fly ssh console -C "kill -KILL <worker-pid>"
# Expect: Fly restarts (on-failure), new boot_id generation appears;
# record observed backoff intervals from `fly status --watch` + logs.

# 6c. Intentional deploy shutdown: fly deploy with no code change must not
# restart-loop the worker (old machine destroyed, new machine boots once).
```

## 8. T5 — heartbeat and database connectivity

```bash
# Fresh worker: generations query shows state=ready, last_heartbeat < 60s,
# sysdb_latency_ms populated, executor worker-1, machine + boot IDs set.
fly ssh console -C "node phase0/p2/enqueue-probes.mjs generations --executor worker-1"
# Stop ONLY the worker process (kill -STOP <pid> freezes it without exit):
# within 3 min + check interval the heartbeat goes stale while web
# /health stays green (curl the web URL) — proving liveness separation.
# Then kill -CONT and confirm the SAME generation resumes beating
# (no new boot row for a mere pause).
# Database loss: revolve the Neon branch to an unreachable endpoint on a
# CLONED worker machine only; expect unhealthy marking and no new side
# effects (fail closed). Never break the proof worker's database.
```

## 9. T6 — Neon connection behavior

Run the T2 core flow twice, differing only in the application URL:

1. Direct endpoint (main acceptance): full T2 green.
2. `-pooler` endpoint for `P2_APPLICATION_DATABASE_URL` only (sysdb
   stays direct — DBOS system connections are never pooled): record
   whether transactional enqueue, recovery, and lifecycle behave
   identically; any error, retry storm, or semantic difference FAILS the
   pooled variant and is recorded as a constraint (pooled app traffic
   stays unapproved until resolved).

Record pool sizes (worker datasource 8, sysdb SDK-managed 10, operator
commands 1–2), `SHOW max_connections`, and any observed queueing.

## 10. Evidence bundle and teardown

Capture per run: `fly status --watch` transcript, deploy event log,
executor-ID boot lines, `app.p2_worker_generation` full dump,
`app.p2_probe_log` for the run tag(s), `app.p2_provider_ledger` rows,
DBOS workflow histories (`status` per workflow ID), every timestamp.
Any executor overlap or second acceptance = FAIL with exact excerpts.

```bash
# Teardown (destroys ONLY the named staging app + Neon branch):
fly apps destroy openlevel-p2-staging  # confirm prompt; nothing else matches
# Then delete the Neon staging branch from the Neon console (branches page).
# Verify: fly apps list shows no staging app; Neon shows no staging branch.
```
