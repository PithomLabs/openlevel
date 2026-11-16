# Adversarial Code Review — P2 CI Remediation (adv_review7)

Per `docs/plans/prompt25.md`. Review-only: no source files modified, no commits,
no GitHub mutations, no secrets touched, no Docker installed.

## Baseline

Branch `phase0/p2-staging-readiness` (PR base: `master`). The remediation is
**unpublished working-tree state**, not committed: 6 modified files, 0 staged,
plus 2 untracked implementation/test files and 6 untracked `docs/plans/*.md`
planning notes (context only; not part of the fix). Working tree differs from
`fork/phase0/p2-staging-readiness` by exactly the remediation, so **no post-fix
Actions run can exist yet**.

Remediation scope confirmed minimal and on-target: `phase0/setup-contracts.ts`
(new), `phase0/setup-contracts.test.ts` (new), `phase0/setup-db.ts`,
`phase0/p2/setup-staging.mjs`, `phase0/p2/setup-staging.test.ts`,
`phase0/p2/packaging.test.ts`, `.github/workflows/phase0.yml`, `package.json`
(one test-file addition).

---

### Executive verdict

**INSUFFICIENT EVIDENCE** — the code review found no correctness blocker (one
LOW finding, three informational observations), but the mandatory Docker-backed
validation does not exist: the fix is unpublished, so there is no post-fix run
of `integration`, `p2-boot-proof`, or `p2-packaging`. Local test/typecheck
claims also could not be re-verified here (this review environment has no Node
runtime). Per the brief, a clean code review and a green CI run are two
distinct gates; only the first is satisfied.

---

### Findings

**F-01 — `UNIT_TEST_FILES` omits the new contract test; local orchestrated
runs skip it.**
Severity: LOW. Files: `phase0/provisioners/types.ts` lines 45–62 vs
`package.json` line 21.
Observed: `test:phase0:unit` lists 17 files including
`phase0/setup-contracts.test.ts`, but `UNIT_TEST_FILES` still lists 16 without
it. `test-env.ts run` (lines 95–106, 99) executes `UNIT_TEST_FILES`, so a local
full run (`npm run test:phase0`) silently skips the new Fix A regression test.
Why a defect: two sources of truth for the unit set have drifted; the exact
test guarding the `42P01` fix won't run on the orchestrated path. CI is
unaffected (`unit` job uses the package script; `integration` job passes
`--no-unit`), hence LOW, not blocking.
Repro: run `node --import tsx phase0/test-env.ts run` locally —
`setup-contracts.test.ts` never executes.
Why tests don't catch it: the drift guard in
`phase0/provisioners/provisioners.test.ts` lines 74–81 is one-directional
(every `UNIT_TEST_FILES` entry must be in package.json, not the reverse).
Smallest fix: add `'phase0/setup-contracts.test.ts'` to `UNIT_TEST_FILES` in
the same position; optionally assert set-equality in the guard test.

**F-02 — Live CI cannot prove the ownSys/ownApp privilege boundary; only the
static pin does.**
Severity: INFORMATIONAL. Files: `.github/workflows/phase0.yml` lines 112–114,
`phase0/p2/setup-staging.test.ts` lines 178–197.
Observed: `p2-boot-proof` sets both database URLs to identical superuser
credentials, so `verify-staging-apply.mjs` would pass even if role creation ran
on the wrong pool. The boundary rests solely on the source-order test pinning
`ownSys.query(createRoleStatement(...))` before `DBOS.migrate(`. Verified the
pin fails against the original code on both ordering and connection target
(original had `ownApp` creation after migrate), and the comment in the test
honestly discloses this limitation. No code defect; do not cite a green
`p2-boot-proof` as privilege-boundary proof.

**F-03 — Three regression pins are source-textual, not behavioral.**
Severity: INFORMATIONAL. Files: `phase0/setup-contracts.test.ts` lines 49–57,
`phase0/p2/setup-staging.test.ts` lines 186–196,
`phase0/p2/packaging.test.ts` lines 34–43.
Observed: Fix B's and Fix C's tests and Fix A's wiring test match literal
source strings. Each was verified to fail against the original implementation
(missing import / `ownApp` creation / `; test $?` respectively), and each has a
live runtime counterpart on CI (`verify-staging-apply.mjs`, the actual workflow
step, the value-based exact-set test). Residual risk is narrow and contrived
(e.g., the matched literal surviving in a comment while real logic regresses).
Non-blocking; a future hardening could assert single-occurrence outside
comments.

**F-04 — `dbos` retained in the inventory schema list matches nothing;
harmless.**
Severity: INFORMATIONAL. File: `phase0/setup-contracts.ts` line 40.
Observed: `PROTOTYPE_INVENTORY_SCHEMAS` keeps `'dbos'` from the original query
though no `p1_/p2_/p3_` relations exist there. It only feeds a human-readable
log count with no consumers (single `console.log` at `phase0/setup-db.ts` line
104). Behavior-preserving; no action needed.

**Adversarial challenges investigated and cleared (no finding):**
- Allowlist: all 9 entries verified to exist in `public` on the setup-db path
  (5 P1 from `p1/schema.sql` + `p1/worker-schema.sql`, 4 P3 from `p3/schema.sql`);
  `p2_probe_log` absent; exact-set value test rejects the original 10-entry list;
  single `GRANT TRUNCATE` site, fixed-literal quoting, no shadow list anywhere.
- `p3_attempt_archive` correctly excluded: no test truncates it (P1/P3/backpressure
  TRUNCATE statements enumerated; all covered), and teardown drops via bootstrap,
  not the runtime role.
- No `phase0_rt` consumer touches `app.*` or `p2_*`: P1/P3/backpressure suites, P1
  worker, reconcile (bootstrap, unqualified `public` names), preflight, and both
  teardown paths inspected. No additional `app` grant needed; no broad grants
  introduced.
- Teardown: schema-qualified `schema.table` identities end-to-end
  (`splitTableIdentity` validation, FK edges, deletes, drops), bootstrap pool,
  ledger semantics untouched.
- Role fix: SDK 5.5.0 source confirms
  `DBOS.migrate(..., {applicationRole})` → `migrateSystemDatabase` →
  `grantDbosSchemaPermissions` naming the role, so pre-creation is the true
  root-cause fix. Creation is NOLOGIN, idempotent (`duplicate_object` only —
  permission errors still propagate), via `ownSys`, before every granting
  operation; CONNECT via `ownSys`, app grants via `ownApp`. No other
  role-assuming path: `ci-boot-proof.sh` migrates without `applicationRole`, P1
  worker sets no `applicationRole`, probe worker uses `runMigrations: false`,
  setup-db creates its role before granting. Live double-apply test exercises the
  real `applyStagingSetup` twice with sentinel, inventory, P3 function/trigger,
  as-role DML, rollback, and residue checks — all present and correctly indexed.
- Bash fix is byte-for-byte the expected correction; `-e` retained with no
  `shell:` override; exit 0/1 fail, exit 2 passes; `probe-web.mjs` untouched
  (ROLE≠web exits 2 before any DB touch); image still production-only
  (`npm ci --omit=dev`, `tsx` in dependencies, no baked secrets).
- No scope creep: no new migration/queue/locking/infra, no unrelated edits.

---

### Verification matrix

Local (this review environment — no `node`, `npm`, `gh`, `docker`, or `psql` on
PATH):
- `test:phase0:unit` (17 files / 277 tests claimed): **NOT RUN** — no runtime.
  Statically corroborated the 17-file list (counted, no duplicates) and read all
  three new/changed test files; no syntax or type red flags.
- Root `tsc` + phase0 `tsc`: **NOT RUN** — no runtime. Static check: root config
  excludes `phase0/` (unaffected by this change); phase0 config includes
  `./**/*.ts` so both new files are gated; import style
  (`./setup-contracts.js`) matches convention.
- Pre-fix failure reproduction without modifying the branch: **INSUFFICIENT** —
  no runtime to execute even a copied harness; instead verified textually that
  each regression test's assertions contradict the original code (original
  allowlist content, original `ownApp` ordering, original `; test $?` line, all
  recovered from `git diff`).

GitHub Actions: **NOT RUN** for all jobs (`unit`, `typecheck`, `app-suite`,
`integration`, `p2-boot-proof`, `p2-packaging`). The remediation is unpublished,
so run 43719980758 remains the latest evidence and is pre-fix. Docker-backed
validation is **unverified**.

---

### Scope and regression assessment

- P1 preserved: yes — atomic enqueue/worker paths untouched; TRUNCATE allowlist
  still covers all 5 P1 tables the suites reset.
- P3 preserved: yes — wallet/runner/tests untouched; 4-table TRUNCATE set covered;
  archive trigger semantics unchanged.
- Backpressure preserved: yes — suite untouched, its 5-table TRUNCATE covered.
- Vault baseline preserved: yes — `app-suite` job and baseline gate untouched.
- Ownership/teardown guarantees preserved: yes — ledger, snapshot, planner, and
  both provisioners untouched; remediation adds no objects to ownership scope.
- System/application connection boundary preserved: yes — staging role/CONNECT on
  system pool, app DDL/grants on application pool; DBOS grants still via the
  supported SDK mechanism.
- Application fail-closed behavior preserved: yes — setup still fails closed on
  missing relations (single atomic GRANT), staging refusals untouched, probe-web
  exit codes untouched.

### Final recommendation

Do not merge yet. Apply the one-line F-01 fix (`UNIT_TEST_FILES`), publish the
branch, then require a green post-fix Actions run covering all jobs — at minimum
`integration`, `p2-boot-proof`, and `p2-packaging` — before merge. The code
itself is in good shape; only the evidence gate is missing.
