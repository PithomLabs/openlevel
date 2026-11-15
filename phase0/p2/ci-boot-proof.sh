#!/usr/bin/env bash
# P2 T1-positive boot proof (CI only). Boots the REAL probe worker against
# the CI postgres service database, waits for readiness, SIGTERMs it, and
# asserts a clean, fully-recorded lifecycle. See STAGING_ACCEPTANCE.md T1.
#
# Env in (set by the workflow job):
#   P2_SYSTEM_DATABASE_URL, P2_APPLICATION_DATABASE_URL (service postgres)
# Requires: node 22, production-only install (npm ci --omit=dev). tsx MUST
# be a runtime dependency (pinned by packaging.test.ts) — this script
# proves the worker boots without any dev-only package present.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

: "${P2_SYSTEM_DATABASE_URL:?P2_SYSTEM_DATABASE_URL is required}"
: "${P2_APPLICATION_DATABASE_URL:?P2_APPLICATION_DATABASE_URL is required}"
export P2_SYSTEM_DATABASE_URL P2_APPLICATION_DATABASE_URL

echo "--- p2 schema (service postgres) ---"
psql "$P2_APPLICATION_DATABASE_URL" -v ON_ERROR_STOP=1 -f phase0/p2/schema.sql
echo "--- dbos system migrations ---"
node --input-type=module -e "import('@dbos-inc/dbos-sdk').then(async ({ DBOS }) => { await DBOS.migrate(process.env.P2_SYSTEM_DATABASE_URL, { schemaName: 'dbos' }); console.log('dbos system schema: migrated'); })"

echo "--- boot real probe worker ---"
LOG="$(mktemp)"
ROLE=worker \
  P2_WORKER_ENTRY=./phase0/p2/probe-workflows.ts \
  node --import tsx phase0/p2/boot-worker.mjs >"$LOG" 2>&1 &
WORKER_PID=$!

READY=0
for _ in $(seq 1 60); do
  if grep -q "p2 probe worker up" "$LOG" 2>/dev/null; then READY=1; break; fi
  if ! kill -0 "$WORKER_PID" 2>/dev/null; then break; fi
  sleep 1
done
if [ "$READY" != "1" ]; then
  echo "FATAL: probe worker did not become ready within 60s"
  tail -n 40 "$LOG"
  kill -KILL "$WORKER_PID" 2>/dev/null || true
  exit 1
fi
echo "worker ready (executor init + heartbeat observed in log)"
sleep 35 # allow at least one 30s heartbeat beat after the ready mark

echo "--- SIGTERM graceful shutdown ---"
kill -TERM "$WORKER_PID"
EXIT=0
for _ in $(seq 1 60); do
  if ! kill -0 "$WORKER_PID" 2>/dev/null; then wait "$WORKER_PID" && EXIT=0 || EXIT=$?; break; fi
  sleep 1
done
if kill -0 "$WORKER_PID" 2>/dev/null; then
  echo "FATAL: worker did not exit within 60s of SIGTERM"
  kill -KILL "$WORKER_PID" 2>/dev/null || true
  exit 1
fi
echo "worker exit code: $EXIT"
[ "$EXIT" = "0" ] || { echo "FATAL: expected clean exit 0"; tail -n 40 "$LOG"; exit 1; }

echo "--- generation lifecycle evidence ---"
psql "$P2_APPLICATION_DATABASE_URL" -tAc \
  "SELECT count(*) FROM app.p2_worker_generation WHERE executor_id = 'worker-1' AND state = 'stopped' AND shutdown_at IS NOT NULL" \
  | grep -q "^1$" || { echo "FATAL: expected exactly one stopped worker-1 generation"; exit 1; }
psql "$P2_APPLICATION_DATABASE_URL" -tAc \
  "SELECT count(*) FROM app.p2_worker_generation WHERE executor_id = 'worker-1' AND state IN ('starting','ready')" \
  | grep -q "^0$" || { echo "FATAL: stale active generations remain"; exit 1; }
grep -q '"vmid":"worker-1"' "$LOG" || { echo "FATAL: boot log lacks worker-1 identity line"; exit 1; }

echo "P2 T1-positive boot proof: PASS"
