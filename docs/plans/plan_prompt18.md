# Plan: implement docs/plans/prompt18.md — P2 Fly/Neon staging acceptance readiness

## Goal

Make the P2 Fly/Neon staging harness genuinely executable, fail-closed, and capable of producing credible evidence; deliver the readiness report, executable acceptance package, evidence updates, Git report, and verdict. Zero cloud operations; no commit or push (owner handles Git publication).

## Verified starting state

- `fork/master` fetched = `35254781f3753f61cda568bac4665551c589d047` (the claimed PR #1 merge commit).
- `git diff 123073c fork/master` is empty: the checkout (branch `phase0/automated-testing`, HEAD `123073c`) is content-identical to controlling-branch master. Work stays on this branch; the Git report states the equivalence.
- Working tree clean except untracked `docs/plans/prompt18.md` (plus pre-existing unrelated untracked items); the `.gitignore` modification seen in earlier turns is no longer present.
- Both claimed P2 defects confirmed in place: `phase0/p2/boot-worker.mjs:30-34` exits 0 on missing `P2_WORKER_ENTRY`; `phase0/p2/probe-workflows.ts:51,62` uses a 15 s delay plus `attempt-uncertain` marker with no real side-effect proof.
- No production DBOS worker exists: `server/` runs on pg-boss (no `DBOS.launch`/`DBOSClient`); `Dockerfile.p2staging` and `dist/boot.js` (referenced by `fly.staging.toml`) do not exist. The probe worker therefore IS the staging worker.
- `phase0/setup-db.ts` / `phase0/db-guard.ts` enforce the `phase0_*` namespace plus loopback, which Neon staging can never satisfy — staging needs its own non-destructive setup path.
- P2 surface is 5 files (~9 KB): `boot-worker.mjs`, `fly.staging.toml`, `probe-workflows.ts`, `proof-checklist.md`, `schema.sql`. Governing docs: `docs/architecture/OPENLEVEL_DBOS_FLY_NEON_ARCHITECTURE_V2_1.md` (772 lines), `docs/plans/plan6.2.md` (338 lines).

## Success criteria

- Boot wrapper fails closed on every T1 case (missing/wrong ROLE, missing sysdb URL, conflicting VMID, missing entrypoint) with an unmistakable explicit dry-run mode; DB connectivity verified pre-import; failures never masked — each proven by spawned-process unit tests.
- Probe workflows executable end-to-end via an operator-invoked, non-public enqueue/inspect mechanism; provider simulation reuses P3 decision logic over a DB-durable fake ledger and proves no second dispatch after restart; heartbeat reflects real readiness (executor + Machine + boot + timestamp + DB state); staging schema idempotent, sufficient, and actually applied by the staging setup path.
- Fly config reconciled against V2.1, plan6.2, and current Fly docs with the rolling-vs-stop-then-start question settled into observable no-overlap criteria; region placeholder explicitly staging-only.
- Executable T1–T6 package (T1 runnable locally; T2–T6 as authorized-only procedures with evidence capture + teardown); matrix updated only for genuinely newly-proven static/unit results; T1–T6 remain BLOCKED.
- All three gates green; verdict `READY FOR OWNER AUTHORIZATION` (or `FIX REQUIRED`/`BLOCKED` with the exact gap); zero cloud, secret, production, or Docker actions taken.

## Approach

Review-then-repair per finding: reproduce each defect against the real file, fix the cause at its narrowest scope reusing P1/P3 machinery, pin each fix with focused unit tests, and keep every staging-only behavior as procedure-plus-capture-scripts rather than untestable prose.

## Steps

1. **Repo state + doc grounding.** Re-verify status/branch/log; read V2.1 §5/§10, plan6.2 deployment sections, matrix P2 rows, and P3's provider interfaces to fix the ledger-reuse seam (fallback if non-importable: minimal staging-local module, disclosed not hidden).
2. **Workstream A — boot fail-closed.** Remove the exit-0 dry-run path; require `P2_WORKER_ENTRY` (fail closed when unset); add explicit `P2_DRY_RUN=1` mode with an unmistakable banner; verify DB connectivity + config pre-import; keep VMID-exclusive assignment and conflict refusal. Tests: spawn the wrapper for all six T1 cases, assert exit codes and zero executor init.
3. **Workstream A — probe execution.** Wire `P2_WORKER_ENTRY` to the probe worker; add `phase0/p2/enqueue-probes` + inspect commands over `DBOSClient` (run via `fly ssh console`, no public route) with run tagging; verify launch/queue/drain/shutdown ordering against installed SDK 5.5.0 types; unit-test arg validation and failure modes.
4. **Workstream A — provider simulation.** Reuse P3's reserve/dispatch/uncertain-decision logic against a new DB-durable staging provider ledger (file journals don't survive Machine replacement); model op identity → attempt → persisted dispatch → uncertain outcome → ledger-consulting recovery; invariant: no second dispatch after restart/response-loss. Unit-test the recovery decision table; live proof stays staging-only.
5. **Workstream A — heartbeat + schema.** Minimal emitter post-`DBOS.launch` (executor, `FLY_MACHINE_ID`, boot id, timestamp, readiness, sysdb latency) into `p2_heartbeat`; extend `p2/schema.sql` (heartbeat + provider ledger, idempotent); build the Neon-safe staging setup path (explicit allowlist, non-destructive, no `phase0_*`/loopback assumptions); unit-test heartbeat classification (fresh/stale/unhealthy) and schema idempotency shape.
6. **Workstream B — Fly reconciliation.** Inspect current Fly docs for rolling/`max_unavailable` semantics at count 1, restart policies, and Machine-event observability; settle V2.1 vs plan6.2 into exact no-overlap observables (executor-active windows from heartbeat + DBOS tables vs Machine timestamps); fix `fly.staging.toml` (build the missing `Dockerfile.p2staging` decision, web command viability, worker count/policy, no app-wide VMID); record region as disposable-staging-only.
7. **Workstream C — executable package.** Write `phase0/p2/STAGING_ACCEPTANCE.md` + capture scripts: T1 local run, T2/T3 deploy-and-kill procedures with Machine-state capture, T4 signal/restart policy checks, T5 heartbeat/staleness queries, T6 Neon direct-vs-pooled connection matrix with the intended pool sizing; evidence bundle definition + teardown. Everything staging-side is procedure, nothing executed.
8. **Validation + deliverables.** Three gates green; new unit tests for every fail-closed path; matrix rows added/flipped only for proven static/unit results (T1–T6 stay BLOCKED); deliverables A–E (readiness report, acceptance package, evidence updates, Git report, verdict).

## Validation plan

- `npm run typecheck`, `npx tsc -p phase0/tsconfig.json --noEmit`, `npm run test:phase0:unit` — all green, including spawned-wrapper T1 tests and new predicate/decision tests.
- Each Workstream A fix maps to a test that fails on the pre-fix code (dry-run exit 0, missing-entry boot, unreused provider path, heartbeat-without-readiness, non-applied schema).
- No-weaken audit: provenance, loopback, guards, SCRAM, ownership teardown, P1/P3/BP behavior all untouched (diff inspection); evidence labels use only the five §7 categories honestly.
- Highest-risk validation: the staging-ledger reuse seam (step 4) — verified by reading P3's actual interfaces first, never by assuming importability.

## Risks and boundaries

- If P3's provider logic proves non-importable outside vitest fixtures, use a minimal staging-local ledger module mirroring its decision table (duplication disclosed, not hidden) — decided at step 1.
- If current Fly docs contradict both V2.1 and plan6.2 on single-worker rolling semantics, verdict is `BLOCKED` with the exact semantic gap rather than a picked reading.
- No fly/neon CLI invocations of any kind (not even reads); no commits or pushes; no `.env` access; no Docker; no production resources. Procedure text comes from docs; live state belongs to the authorized staging turn.
- Scope exclusions (§8): no V2.1 reopen, no Phase 1A, no RLS, no pg-boss replacement, no multi-worker, no custom fencing without demonstrated necessity, no monitoring platform, no portability implementation, no cosmetic doc rewrites.
