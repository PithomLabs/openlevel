# Independent Adversarial Review — OpenLevel P2 Staging Readiness

Review assignment: `docs/plans/prompt19.md`. Primary assignment: `docs/plans/prompt18.md`.
Reviewer: independent senior architect (not the implementation agent).
Repository: `PithomLabs/openlevel`. Branch: `phase0/p2-staging-readiness`.
Base: merged PR #1 commit `35254781f3753f61cda568bac4665551c589d047` (HEAD == base;
implementation uncommitted: 13 modified files, 22 new files).
Review mode: read-only; nothing modified, committed, or pushed. No Fly/Neon/Docker/production
operations, no `.env` access, no secrets. Previous CI failure baseline noted where relevant.
READY here would authorize publication/CI only — never Fly/Neon deployment.

---

## Verdict: FIX BEFORE PUSH

Five MAJOR defects, all small and precisely fixable — no redesign needed. The core mechanisms
are genuinely good (fail-closed boot, real transaction separation in recovery, clean P3 seam,
sound evidence checkers), but the branch as it stands cannot execute staging (two packaging
gaps) and cannot soundly prove its central fencing claims (three proof gaps).

---

## MAJOR findings

### M1 — Staging image cannot boot: tsx pruned by --omit=dev

| Field | Content |
|---|---|
| **Severity** | MAJOR (staging package unrunnable; CI masks it) |
| **File:line** | `phase0/p2/Dockerfile.p2staging:17` (`npm ci --omit=dev`); false comment `:4-6`; same false claim in `phase0/p2/ci-boot-proof.sh` header; `tsx` dev-only at `package.json:55` |
| **Root cause** | Worker command is `node --import tsx ...` but `tsx` lives in devDependencies, so the staging image build prunes it. The Dockerfile comment asserts the opposite. |
| **Concrete failure scenario** | First staging deploy: worker Machine boots → `ERR_MODULE_NOT_FOUND: tsx` → exit 1 → on-failure restarts loop forever. CI stays green (full `npm ci` includes tsx) — a CI-green/staging-red divergence. |
| **Impact** | Every staging worker boot fails; the entire T1–T6 proof is unrunnable. Fail-loud (no ghost executor), but total. |
| **Evidence** | Source-proven: package.json devDependencies listing (1-line diff confirms no move) vs Dockerfile prune + tsx-dependent CMD. Not behaviorally executed (no Docker per boundaries). |
| **Smallest durable correction** | Move tsx to `dependencies` (or equivalent include); correct both comments. |
| **Regression test required** | Unit structure test pinning tsx in `dependencies` (honestly labeled); true proof is the staging boot itself. |

### M2 — P3 tables never created on staging; provider probes cannot run

| Field | Content |
|---|---|
| **Severity** | MAJOR (staging provider cases unrunnable as documented) |
| **File:line** | `phase0/p2/setup-staging.mjs:135-139` (applies only `p2/schema.sql`); `stagingGrants` `:77-87` (proof tables only); consumers `phase0/p2/probe-workflows.ts:76-94` (`opSetupStep` needs `p3_wallet`/`p3_operation`/...) |
| **Root cause** | Setup covers proof tables only; nothing on the staging path creates `app.p3_*` tables or grants DML on them. `STAGING_ACCEPTANCE.md` §1 expects only the three proof tables. |
| **Concrete failure scenario** | T2/T3 provider or uncertain workflow runs `opSetupStep` → `relation "p3_wallet" does not exist` → workflow ERROR. Fail-loud, but every provider/uncertain/recover probe fails. |
| **Impact** | Provider-operation recovery — the most important P2 proof — cannot execute on staging. |
| **Evidence** | Source-proven: exhaustive grep shows no P3 setup anywhere on the staging path (local/CI unaffected: `setup-db.ts:57` applies all four schemas). P3 schema verified self-contained (sole FK internal), so standalone apply works. |
| **Smallest durable correction** | Apply `p3/schema.sql` idempotently into `app` during setup as a single multi-statement query (its `$$` trigger body defeats the semicolon splitter; force `search_path=app` or tables land in `public`), and extend `stagingGrants` to `p3_*` after all tables exist (sequence grants are order-sensitive). |
| **Regression test required** | Setup test asserting both files applied and grants cover `p3_*` tables (stub level); live proof in staging T2. |

### M3 — Fencing evidence unsound; claimed stop-before-start procedure absent

| Field | Content |
|---|---|
| **Severity** | MAJOR (central safety claim unprovable as documented; CRITICAL considered — see impact) |
| **File:line** | Arbiter excludes `draining`: `phase0/p2/schema.sql:39-44`, `phase0/p2/generations.ts:22` (pinned by `probe-config.test.ts:64`); T2 rolling deploy: `STAGING_ACCEPTANCE.md:80`; claim without procedure: `phase0/p2/fly.staging.toml:20-22`; unsatisfiable criterion: `STAGING_ACCEPTANCE.md:84-87` |
| **Root cause** | Three coupled facts: (1) rolling deploys structurally overlap old-draining/new-ready, the exact mode the arbiter cannot see — the no-overlap check passes during genuine concurrent-executor overlap; (2) the credited "operator stop-then-start procedure" has no steps anywhere (T2 = plain `fly deploy`); T2's "old stops before replacement executes" is unsatisfiable under rolling; (3) installed SDK source proves the stakes — `reenqueueWorkflowsForRecovery` re-enqueues ALL same-VMID PENDING workflows on launch with no liveness check, so overlapping executors double-execute in-flight work. The test suite itself encodes the stop-before-start assumption (draining never legally coexists with ready), making the absent procedure the sharp edge. |
| **Concrete failure scenario** | T2 rolling deploy: old worker draining (finishing an in-flight provider step) while replacement launches and re-enqueues the same workflow → both execute the dispatch concurrently → generation arbiter reports empty (old is `draining`) → fencing acceptance PASSES with two executors active. |
| **Impact** | The no-concurrent-executor proof is unsound. Settled at MAJOR, not CRITICAL: staging data is synthetic; a resulting double-accept is post-hoc-detected by the exactly-one-acceptance check (never a false PASS at ledger level); and the in-flight trigger is unreachable in the documented T2/T3 timing (see M5). The defect is unsound proof, not live corruption. |
| **Evidence** | Source-proven (arbiter predicate + test pin + procedure text + SDK recovery implementation read directly). Live overlap behavior is staging-only. |
| **Smallest durable correction** | Add enforced + recorded stop-verify-start replacement steps to the fencing proof (stop machine, verify stopped via status + generation row, then start replacement, record all timestamps); separate rolling-deploy mechanics (completed-work integrity) from the fencing claim; keep the arbiter as-is (valid once draining-overlap is unreachable-by-procedure). |
| **Regression test required** | Evidence-bundle checklist requiring the stop-verify-start transcript; optionally a unit structure test pinning the doc's required steps (honestly labeled as a guard, not runtime proof). |

### M4 — Ledger UNIQUE does not enforce the stated exactly-one invariant

| Field | Content |
|---|---|
| **Severity** | MAJOR (recovery guard lacks its database backstop; coupled to M3) |
| **File:line** | `phase0/p2/schema.sql:55` (`UNIQUE (operation_id, attempt_id)`); check-then-act: `phase0/p2/probe-workflows.ts:108-116` + `phase0/p2/staging-provider.ts:47-58`; stated invariant: `staging-provider.ts:20,22` ("exactly one ledger row per operation_id") |
| **Root cause** | The constraint permits two acceptances for one operation under different attempt IDs, and the count/assert pre-checks take no lock — concurrent dispatch (reachable under executor overlap per M3 + the SDK recovery evidence) double-accepts silently at the DB level. |
| **Concrete failure scenario** | Replacement replays `opDispatchStep` while the original worker's provider call is still in its hold window: both read count 0, both INSERT with different attempt IDs, both succeed → 2 ledger rows, 1 operation. |
| **Impact** | Possible duplicate provider operation — caught post-hoc by `check-recovery` (FAIL, never false PASS), but prevention is absent where it should be definitional. |
| **Evidence** | Source-proven (constraint text vs invariant text; race trace through autocommitted INSERTs). Live concurrency is staging-only. |
| **Smallest durable correction** | `UNIQUE(operation_id)` — safe for every designed flow (at most one acceptance per operation by design; the suppression path inserts none). Converts residual risk from silent-duplicate to loud-23505. |
| **Regression test required** | Schema test asserting the constraint (extends the existing schema-pin test style); live ledger counts in T2/T3. |

### M5 — T2 cannot place provider dispatch in-flight across replacement

| Field | Content |
|---|---|
| **Severity** | MAJOR (acceptance test passes without testing its headline scenario) |
| **File:line** | `phase0/p2/STAGING_ACCEPTANCE.md:73-94` (enqueue → wait → deploy; no hold configured; criterion "while workflows are active"); hold mechanism exists only for T3 (`:99-103`, `P2_PROVIDER_DELAY_MS`); normal workflow has no hold (`probe-workflows.ts:149-158`) |
| **Root cause** | Deploy latency (minutes) dwarfs workflow duration (seconds), and T2 configures no hold — "wait for in-flight" is unachievable, so T2 will run all-complete and pass while proving only completed-work integrity, not in-flight replacement recovery. |
| **Concrete failure scenario** | Operator follows T2 verbatim: all three workflows complete within seconds of enqueue; deploy replaces the worker minutes later; every acceptance criterion passes (marks exact, one ledger row, uncertain quarantined) with zero in-flight recovery exercised. |
| **Impact** | T2's headline scenario (replacement during active provider dispatch) is untested despite a PASS. The weaker completed-work-integrity property it does prove is valuable — keep it as an explicit sub-claim. |
| **Evidence** | Source- and procedure-proven (workflow durations vs deploy latency; hold only wired for T3). |
| **Smallest durable correction** | Apply T3's hold technique to T2 (provider delay + normal-workflow hold or enqueue-during-deploy loop) and assert the in-flight precondition (dispatch mark present, post-call absent) immediately before replacement. |
| **Regression test required** | Procedure + bundle requirement showing in-flight marks at replacement time. |

---

## MINOR / INFO

- **m1 (MINOR):** operator CLI sharp edges — bare `--expect-recovery` (no `1`) silently yields `expectRecovery=false` (`check-recovery.mjs:30`), weakening the check; `--queue` override can strand workflows on an unregistered queue (`enqueue-probes.mjs:42,45`). Fix: reject the bare flag; restrict queue to `p2`. Workaround: documented usage. Regression: `parseArgs` unit tests.
- **m2 (MINOR):** runtime uses owner credentials (`fly secrets set` reuses migrator URLs) while the docs imply minimal grants — and `dbos.*` system-table grants are missing entirely (`DBOS.migrate`'s `applicationRole` unused). Works on disposable staging. Fix: adopt `applicationRole` + restricted runtime role, or correct the claim.
- **i1 (INFO):** 22 new files (21 under `phase0/p2/` + `.dockerignore`), not 20 as reported — trivial reporting nit; all scope reviewed and justified. The `.gitignore` hunk (local SDK clone dir) is unrelated-but-harmless; owner may keep or drop.
- **i2 (INFO):** T3's SIGKILLed generation stays `ready` forever (nothing writes `stopped`); overlap evaluation must apply the 3-minute freshness rule — add one line to T3 acceptance.

---

## Area dispositions (prompt19 §§1–11)

- **§1 boot fail-closed:** PASS — all T1 negatives spawned-tested (11/11), dry-run unmistakable, connectivity before import, VMID worker-only, CWD resolution fail-loud. Positive init correctly deferred to CI.
- **§2 DBOS execution:** PASS — every API call verified against installed SDK 5.5.0 `.d.ts` (setConfig/launch/registerQueue-after-launch/shutdown/DBOSClient/enqueue/retrieveWorkflow); operator surface client-only; `/p2/status` read-only with no enqueue path (public readability of synthetic staging statuses reviewed and accepted).
- **§3 recovery path:** transaction separation SOURCE-VERIFIED (attempt gate commits pre-contact; ledger INSERT autocommits independently; outcome update separate) — the kill windows are real; suppression + recover-workflow + check-recovery coherent; gaps are M2/M4.
- **§4 fencing:** per M3 — observational table (correctly not DB-enforced), procedure missing.
- **§5 shutdown:** PASS — draining recorded pre-shutdown, 100s cap under 120s kill timeout, truthful 0/1 exits matched by on-failure restart (no loop), crash-vs-clean distinguishable; CI observes real SIGTERM behavior.
- **§6 heartbeat:** PASS — emitted only post-launch with sysdb latency probe, freshness-gated classifiers, web/worker liveness separated.
- **§7 Neon:** setup refuses loopback/plaintext/confirm-mismatch/redirect-env, additive-only, redacted; sysdb stays direct, pool sizes match V2.1 (worker 8 verified in arch doc); gaps are M2/m2; no static claim of Neon compatibility made.
- **§8 Fly:** rolling≠fencing honestly documented; no app-wide VMID; restart/sizing/health correct; count=1 via procedure (`fly scale`), verified step present.
- **§9 P3 seam:** PASS — minimal exactly-one-of seam, default path byte-identical semantics, gate/budgets/transitions untouched; existing integration job still runs P1/P3/backpressure in CI.
- **§10 CI:** PASS — triggers cover PR-against-master, no secrets (ephemeral service password), real boot/drain/assertions, nonzero-on-failure, T1–T6 stay BLOCKED (P2-CIBOOT honestly NOT RUN); YAML parsed, execution honestly unclaimed.
- **§11 scope:** base `3525478` correct, 13 modified + 22 new all justified (teardown went schema-qualified end-to-end with ledger-format compatibility verified — setup and teardown both flow through the qualified snapshotter); `automated-testing`/`master` untouched; no secrets, no production config.

---

## Validation (executed)

`npx tsc -p phase0/tsconfig.json --noEmit` → exit 0; `npm run typecheck` → exit 0;
`npm run test:phase0:unit` → **221/221 across 13 files** (per-file counts exactly match the
matrix: 11 boot, 16 setup, 7 ledger, 7 config, 10 commands, 5 web, 59 provisioners). DBOS API,
pool sizing, and transaction boundaries corroborated against installed dependency source, not
comments.

---

## Next action

Apply the five small fixes (move tsx to dependencies; P3 schema + grants in setup;
stop-verify-start fencing steps; `UNIQUE(operation_id)`; T2 holds + in-flight precondition),
re-run the three checks, then publish `phase0/p2-staging-readiness` and open the PR against
`master` — requiring `p2-boot-proof`, Phase 0 unit/integration, and CodeRabbit before any
Fly/Neon staging authorization is sought.
