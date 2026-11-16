# Plan: implement docs/plans/prompt24.1.md — revised P2 CI remediation (run 43719980758)

## Goal

Implement the prompt24 remediation of the three deterministic CI failures (`integration`, `p2-boot-proof`, `p2-packaging`) with the two mandatory amendments from the adversarial review in prompt24.1: a genuinely discriminating Fix A regression test, and Fix B role creation through the system connection. No architecture changes, no commits or pushes (owner handles Git publication), no Docker-backed validation locally, no secrets or cloud operations.

## Verified starting state

- Branch `phase0/p2-staging-readiness`, HEAD `87d9387`; tree clean except untracked `docs/plans/prompt24.md` (and now `prompt24.1.md`).
- `plan_prompt24.md` correctly identifies all three root causes; prompt24.1 approves it with two required corrections, which this plan incorporates. All other prompt24 scope, validation, and Git/cloud boundaries remain unchanged.
- Amendment A premise confirmed: `phase0/setup-db.ts:94-106` builds the grant dynamically from the `prototypeTables` array (`"public"."${t}"` interpolation), so no literal `"public"."p2_` exists in source — a substring assertion would pass on the defective code. `stagingGrants()` and `phase0/p2/schema.sql` are already `app`-correct, so asserting on them cannot catch the local-setup defect either.
- `phase0/setup-db.ts:126` executes `await main()` at top level against a live database, and nothing imports `setup-db.ts` — so the allowlist cannot be unit-tested in place; it must be extracted into an importable pure module. Precedent: `phase0/test-env.ts` exports pure constants (`PG_IMAGE`, exit codes) tested directly in `phase0/test-env.test.ts`.
- Amendment B premise confirmed: `applyStagingSetup` (`phase0/p2/setup-staging.mjs:188-210`) separates `ownSys` (DBOS/system operations) from `ownApp` (application schema), but the existing `createRoleStatement` call sits on `ownApp` (line 205) after `DBOS.migrate` (line 194). Role creation is a system-level operation and must precede the migrate that grants to the role.
- CI blind spot confirmed: `p2-boot-proof` (`phase0.yml:112-114`) supplies the same superuser URL for both system and application connections, so the live `verify-staging-apply.mjs` double-apply proof cannot detect a wrong-pool role creation. The connection target must be pinned statically.
- Teardown already schema-safe (confirm-only): `native.ts:200-203` quotes drops via `splitTableIdentity`, and `provisioners.test.ts:484-496` already covers `app.p2_probe_log` identities.

## Success criteria

- `setup-db.ts` grants `TRUNCATE` only against public-schema tables that exist; the Fix A regression test demonstrably fails on the original allowlist content and passes after the fix; the prototype inventory covers the `app` schema.
- `applyStagingSetup()` executes `ownSys.query(createRoleStatement(appRole))` before `DBOS.migrate()`; NOLOGIN design, sys/app pool separation, CONNECT placement, and idempotent double-apply with sentinel preservation all preserved.
- The packaging negative smoke test asserts exit code exactly 2 under `bash -e` and fails on unexpected 0; `probe-web.mjs` unchanged.
- P1/P3/backpressure, vault baseline, ownership teardown, and staging `app` contract untouched.
- Local gates green: `npm run test:phase0:unit`, `npm run typecheck`, `npx tsc -p phase0/tsconfig.json --noEmit`. Docker-backed gates verified on the next green Actions run after the owner publishes — no local green claim for those.

## Approach

Apply prompt24's three fixes with the two amendments: extract-then-assert for Fix A (test the real allowlist value, not source substrings), and order-plus-pool-target for Fix B (role creation via `ownSys` before migrate). Fix C proceeds exactly as approved. Each regression test must be shown to fail on pre-fix code, not merely pass after editing.

## Steps

1. **Amendment A — extract the TRUNCATE allowlist into a testable module.**
   - Create a small pure module (e.g. `phase0/setup-contracts.ts`) exporting the public-schema `TRUNCATE` allowlist (e.g. `PUBLIC_TRUNCATE_TABLES`) and the prototype inventory schema list (e.g. `PROTOTYPE_INVENTORY_SCHEMAS` including `app`), following the `test-env.ts` pure-export precedent.
   - Rewrite `phase0/setup-db.ts:94-106` to import and use the extracted allowlist (minus `'p2_probe_log'`), and lines 108-113 to use the extracted inventory schemas including `app`. No behavior change beyond the corrected list and schema coverage; do not move any P2 table into `public`; add no `app` grants for `phase0_rt` (no local consumer: P2 unit tests are DB-free, integration covers P1/P3 only).
2. **Amendment A — discriminating regression test.**
   - Add a DB-free test (e.g. `phase0/setup-contracts.test.ts`, wired into `test:phase0:unit`) importing the extracted constants and asserting: `p2_probe_log` is absent from the public TRUNCATE allowlist; every allowlist entry is an expected P1/P3 public table (exact-set assertion, so a new stray entry fails); the inventory schema list includes `app`.
   - Demonstrate discrimination: temporarily restore the original allowlist content (with `p2_probe_log`) and show the test fails, then re-apply the fix and show it passes. Record both results in the report.
3. **Fix A confirm-only checks.** Verify no other `public.p2_*` reference remains; confirm `native.ts` / `testcontainers.ts` teardown consumes `schema.table` identities (already covered by `provisioners.test.ts`) — no teardown changes expected.
4. **Amendment B — role creation via `ownSys` before migrate.**
   - In `applyStagingSetup`, insert `if (appRole) { await ownSys.query(createRoleStatement(appRole)); }` before `DBOS.migrate()`, with a comment stating the role must exist before DBOS grants to it. Remove the old `ownApp` role-creation line; keep CONNECT (via `ownSys`) and `stagingGrants` (via `ownApp`) in place afterward. Update the order comment (lines 184-186). No superuser, no broad ownership, no new CREATE privileges.
5. **Amendment B — ordering + pool-target regression test.**
   - Extend `phase0/p2/setup-staging.test.ts` with a DB-free test asserting both: `createRoleStatement` is invoked before `DBOS.migrate` in the `applyStagingSetup` body, and the invocation target is `ownSys`, not `ownApp`. Show it fails on the original file content (ordering and pool target both wrong pre-fix). Cite the existing live `verify-staging-apply.mjs` double-apply + sentinel + as-role DML proof for runtime behavior; do not duplicate it.
6. **Fix C — workflow assertion (per prompt24.2 refinement).** Replace `phase0.yml:140` with an explicitly initialized capture: `status=0` on its own line, then `docker run --rm -e ROLE=bogus p2staging:ci node phase0/p2/probe-web.mjs || status=$?`, then `test "$status" -eq 2` (exit 0 → fail, 1 → fail, 2 → pass). Extend `packaging.test.ts` with the static workflow test (explicit `status=0` init + safe capture present, exact `-eq 2` present, no bare `; test $? -eq 2` after `docker run`). Leave `probe-web.mjs` unchanged.
7. **Adversarial self-review (prompt24 §3 + review §2).** Verify: no wrong-schema P2 reference anywhere; teardown cannot touch unowned objects; role exists before every DBOS grant via the system connection; reapply preserves data; grants effective as-role; smoke test proves exit 2 without weakening `-e`; every new test fails on pre-fix code; the identical-credential CI blind spot is disclosed, not treated as boundary proof.
8. **Report.** Root cause per failure, exact changed files + rationale, regression tests with pre-fix-fail / post-fix-pass evidence, exact commands with results, unresolved issues with severity. The report must evidence all six prompt24.2 acceptance criteria: Fix A test fails on restored `p2_probe_log` (step 2), Fix B test fails on original ordering/pool (step 5), Fix C proves exact exit 2 (step 6), all three local gates pass, Docker-backed tests reported as not run locally, and no unrelated changes. Do not commit, push, or claim CI green — green requires the next Actions run after the owner publishes.

## Validation plan

- `npm run test:phase0:unit` — green, including the new contract test and the extended staging/packaging tests; pre-fix failure demonstrated for each (temporary content restore, then re-apply).
- `npm run typecheck` and `npx tsc -p phase0/tsconfig.json --noEmit` — green, covering the new module.
- No-weaken audit via diff inspection: P1/P3/backpressure, vault baseline, ownership teardown, NOLOGIN design, sys/app pool split, `probe-web.mjs` fail-closed behavior unchanged.
- Not run locally (no Docker on this Mac): `test:phase0:integration`, staging-apply proof, ledger-race proof, Docker build + smokes — these gate on the next Actions run after the owner publishes.
- Highest-risk validation: the Amendment A discrimination demonstration — proving the new test fails on the original allowlist content. Settled in step 2 by construction (exact-set assertion over the extracted value).

## Risks and boundaries

- If the extraction approach meets resistance (e.g. import-cycle or tsconfig boundary issues), the approved fallback is parsing the array from `setup-db.ts` source in the test — still asserting on the actual list contents, never on substrings. Disclose whichever was used.
- If the static ordering/pool-target test for Fix B proves brittle, keep it minimal (two anchored assertions) and rely on the live double-apply proof for runtime confidence, disclosing the CI identical-credential blind spot.
- No `.env` access, no secret requests, no Fly/Neon connections, no staging/production operations, no Docker install attempts, no commits/pushes/merges/deploys, no GitHub resource mutations.
- Do not rerun the failed workflow as-is before the fixes; do not proceed to Fly/Neon staging T1–T6 — CI acceptance gates come first.
