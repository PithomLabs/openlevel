# ADR-002 — DBOS Pilot for Lead Follow-Up (N2/N3 Disposition)

**Status:** PILOT (per ADR-001 decision template; adoption NOT decided)
**Date:** 2026-11-19
**Context:** prompt39 §9/Priority 2; Review 12 N2/N3; guardrails G1/G2/G5.
**SDK:** `@dbos-inc/dbos-sdk` exact-pinned 5.5.0 (installed; APIs below verified
in `node_modules` + docs.dbos.dev during assessment).

## Necessity

The lead-to-booking MVP does **not** require waits: capture, contact, timeline,
operator visibility, and booking complete without delayed automation. Unsafe
pg-boss waits are therefore **disabled by default** (`WORKFLOW_WAITS_ENABLED`,
G1) independent of this pilot. This pilot is strategic, not MVP-blocking.

## §19 assessment (lead follow-up)

1. **Business process:** a new lead receives an eligibility-gated follow-up
   after a multi-day wait; re-checks eligibility at wake; records the outcome.
2. **Lifetime:** days (pilot proves with short sleeps; mechanism is duration-agnostic).
3. **Durable sleep / external-event waiting:** yes — multi-day sleep is the core.
4. **Checkpoints:** load lead → eligibility → sleep → re-check → follow-up →
   terminal state (5 meaningful stages).
5. **Crash after each step:** must resume from the last completed step without
   repeating completed side effects or stranding (exactly the N2/N3 failure class).
6. **Can PG transactions + pg-boss handle it?** Only by finishing a bespoke
   durability layer: N2 needs same-txn wait persist (runner has no txn today)
   or a waiting-run reaper; N3 needs complete-after-run + a chained-wait
   protocol + per-step sent-markers for partial resumes. Estimated 2–4 weeks
   plus permanent ownership of the state machine Review 12 indicted.
7. **Custom machinery avoided by DBOS:** wait rows, continuations, reaper,
   claims, definition hashes, completion ordering.
8. **DBOS capabilities used:** checkpoints, durable sleep, launch recovery,
   stable workflow IDs (`return-existing`), `applicationVersion` versioning.
   Explicitly NOT used by the pilot: datasource transactions (5.5.0 ships the
   implementer interface only — no drop-in pg datasource; a custom handler
   fails Gate 4 for the pilot), Conductor, queues, sleep suspension.
9. **New obligations:** SDK launch/shutdown lifecycle, system schema migration
   + role grants, register-before-launch ordering, deterministic-workflow
   discipline, identifier-only payloads, step idempotency (steps are
   at-least-once per docs — effects still need business keys), versioning
   strategy, recovery ownership without Conductor (stable executor IDs +
   explicit `recoverWorkflows` for dead executors).
10. **Net simpler?** For wait-bearing workflows, yes — conditionally: the pilot
    must prove kill-and-resume with no duplicate effects using less custom
    recovery code than Option A. For everything else, no (CRUD/jobs stay).

ADR-001 score: 12/14 (lifetime 2, stages 2, waiting 2, recovery 2, effects 2,
coordination 1, human 1) — very strong candidate.

## Decision

**PILOT.** One workflow (`lead-follow-up`), synthetic follow-up effect, no real
messages, no production bootstrap wiring, no Conductor, no pg-boss migration.
One engine per workload: pilot workflows never touch pg-boss wait machinery.

## Pilot acceptance (must all pass)

Stable workflow ID from business identity; duplicate starts return the
existing workflow; txn-handoff via the existing outbox; genuine durable sleep;
worker termination + replacement-worker recovery; resume at the correct
checkpoint; eligibility re-check; synthetic follow-up exactly once;
accurate terminal state; safe cancellation; version-compatibility behavior
explicit; observable execution history; resource cleanup; no duplicate
business side effects under kill-and-resume.

## Fallback

If the pilot fails: waits stay disabled, the assessment names the exact
blockers, and no DBOS code path is left half-wired into production.

## Pilot result (2026-11-19)

**PASSED 9/9** on disposable PostgreSQL 18.7
(`server/dbos/lead-followup.pg.test.ts`, ~37s): full lifecycle via
transactional outbox handoff; duplicate-start collapse with one effect;
missing-contact txn refusal; in-process shutdown mid-sleep + relaunch
recovery; real SIGKILL mid-sleep + replacement-executor recovery with
exactly one effect; fast terminal states (ineligible/no-lead, no sleep);
mid-sleep lapse; cancellation with no effect; version mismatch never
silently resuming (stays PENDING under the wrong version).

Observed operational footprint: 14 system tables in the `dbos` schema
(same cluster, isolated schema); one system-database pool per executor;
recovery is launch-time self-recovery with a stable executor ID (no
Conductor); sleep suspension unneeded at pilot scale (workflows resume
and re-sleep in memory — Enterprise suspension stays a scale-out
question, not a pilot blocker).

No adoption decision: production bootstrap does not launch DBOS, and
staging keeps waits disabled. Cutover (if ever) needs its own migration
plan: datasource decision, role grants, executor topology, monitoring,
and version-drain strategy.

## Sources (inspected 2026-11-19)

- SDK 5.5.0 `dist/src/*.d.ts` (launch/shutdown, startWorkflow+UUID+reuse
  policy, sleep, recoverPendingWorkflows, applicationVersion, datasource
  interface, migrateSystemDatabase).
- https://docs.dbos.dev/production/workflow-recovery
- https://docs.dbos.dev/explanations/concurrent-executions
- https://docs.dbos.dev/typescript/tutorials/workflow-tutorial
