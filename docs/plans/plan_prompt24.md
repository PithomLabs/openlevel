# Plan: implement docs/plans/prompt24.md — P2 CI failure remediation (run 43719980758)

## Goal

Fix the three deterministic CI failures from run 43719980758 (`integration`, `p2-boot-proof`, `p2-packaging`) at their root causes, with regression tests pinning each fix. No architecture changes, no new infrastructure, no commits or pushes (owner handles Git publication), no Docker-backed validation locally, no secrets or cloud operations.

## Verified starting state

- Branch `phase0/p2-staging-readiness`, HEAD `87d9387` ("phase0: complete P2 staging readiness harness"); tree clean except untracked `docs/plans/prompt24.md`.
- Failure A confirmed: `phase0/setup-db.ts:94-106` grants `TRUNCATE` on `"public"."p2_probe_log"`, but `phase0/p2/schema.sql:15` creates `app.p2_probe_log` (header: tables live in `app`, never unqualified `public`). The grant fails with `42P01`.
- Failure B confirmed: `phase0/p2/setup-staging.mjs:194` calls `DBOS.migrate(sysUrl, { applicationRole: appRole })` before `phase0/p2/setup-staging.mjs:205` executes `createRoleStatement(appRole)` — DBOS grants to a role that does not exist yet.
- Failure C confirmed: `.github/workflows/phase0.yml:140` runs `docker run ... ; test $? -eq 2`; under Actions' `bash -e` the expected exit 2 kills the step before `test` runs. `phase0/p2/probe-web.mjs:47-50` correctly exits 2 for `ROLE=bogus` — the program is right, the test line is wrong.
- Local/CI schema contract: P1/P3 integration tests `TRUNCATE` only `public` tables (`phase0/p1/p1.test.ts:114`, `phase0/p3/p3.test.ts:61`, `phase0/p1/backpressure.test.ts:41`); all P2 unit tests are DB-free (listed in `test:phase0:unit`); `phase0/test-env.ts` has no P2 references, so no local consumer needs `phase0_rt` DML on `app` tables. `snapshotPrototypeTables` (`phase0/provisioners/ownership.ts:172`) already tracks both `public` and `app`, and `provisioners.test.ts:484-496` already exercises `app.p2_probe_log` teardown identities.
- Live double-apply coverage already exists: `phase0/p2/verify-staging-apply.mjs:46,90` runs the real `applyStagingSetup` twice with sentinel preservation and as-role DML proof.

## Success criteria

- `setup-db.ts` no longer references any `public`-schema relation that does not exist; P1/P3 integration behavior unchanged; staging `app`-schema contract untouched; ownership ledger still records/cleans only owned objects; setup stays re-runnable.
- `applyStagingSetup()` creates the NOLOGIN role before any DBOS grant, succeeds twice in a row preserving data, with effective as-role DML still proven live.
- The packaging negative smoke test asserts exit code exactly 2 under `bash -e` and fails if the invalid-role invocation ever returns 0; `probe-web.mjs` keeps fail-closed exit 2.
- Each fix has a regression test that fails on the pre-fix code.
- Local gates green: `npm run test:phase0:unit`, `npm run typecheck`, `npx tsc -p phase0/tsconfig.json --noEmit`. Docker-backed gates (`integration`, `p2-boot-proof`, `p2-packaging`) verified on the next GitHub Actions run after the owner publishes.

## Approach

Narrow root-cause repairs, one per failure, reusing established patterns: static DB-free vitest assertions for contract pinning (as `packaging.test.ts` reads the Dockerfile and `setup-staging.test.ts` reads `schema.sql`), and the existing live CI proofs for runtime behavior. No P1, backpressure, vault-baseline, or P3 behavior changes.

## Steps

1. **Fix A — `phase0/setup-db.ts` schema mismatch.**
   - Remove `'p2_probe_log'` from the `public`-schema `prototypeTables` TRUNCATE list (lines 94-106). Do not move any P2 table into `public`.
   - Add no `app`-schema grants for `phase0_rt`: evidence shows no local consumer (P2 unit tests are DB-free; integration covers P1/P3 only). If inspection during implementation finds one, add least-privilege `app` grants narrowly instead of broadening `public`.
   - Fix the verification inventory query (lines 108-113) to include `schemaname = 'app'` so the prototype-relation count is honest about P2 tables.
   - Re-check `native.ts` / `testcontainers.ts` teardown paths consume `schema.table` identities via `splitTableIdentity` (already covered by `provisioners.test.ts`), and confirm no other `public.p2_*` reference remains.
2. **Fix A regression tests.** Add a DB-free contract test (e.g. `phase0/setup-db.contract.test.ts`, wired into `test:phase0:unit`) asserting: `setup-db.ts` contains no `"public"."p2_` reference; `stagingGrants` output contains no `public`; `phase0/p2/schema.sql` still qualifies all proof tables to `app`. Each assertion must fail if the local/CI and staging contracts are conflated again.
3. **Fix B — `phase0/p2/setup-staging.mjs` role ordering.**
   - Move `createRoleStatement(appRole)` execution before `DBOS.migrate(...)` inside `applyStagingSetup`, keeping the NOLOGIN DO-block, the separate sys/app pools, CONNECT grant placement, and idempotency. Update the order comment (lines 184-186) to match.
   - No superuser, no broad ownership, no new CREATE privileges.
4. **Fix B regression test.** Extend `phase0/p2/setup-staging.test.ts` with a DB-free ordering test asserting `createRoleStatement` is invoked before `DBOS.migrate` in the `applyStagingSetup` body (source-order assertion, consistent with existing static tests). The live "succeeds twice" proof already exists in `verify-staging-apply.mjs` (first apply + sentinel + reapply); do not duplicate it, cite it.
5. **Fix C — `.github/workflows/phase0.yml:140` bash `-e` capture.**
   - Replace `docker run ... ; test $? -eq 2` with an `-e`-safe exact-code assertion, e.g. `docker run --rm -e ROLE=bogus p2staging:ci node phase0/p2/probe-web.mjs || status=$?` followed by `test "${status:-0}" -eq 2`. The `||` list suppresses `-e` termination; the `test` still demands exactly 2 and fails on unexpected 0. Do not touch `probe-web.mjs`.
6. **Fix C regression test.** Extend `phase0/p2/packaging.test.ts` with a static test reading `.github/workflows/phase0.yml`: assert no bare `; test $? -eq 2` follows a `docker run`, and assert the negative-smoke step contains the safe capture pattern plus the `-eq 2` assertion.
7. **Adversarial self-review (prompt24 §3).** Before finishing, verify: no remaining wrong-schema P2 reference anywhere; teardown cannot drop/truncate unowned objects; role exists before every DBOS grant; reapply preserves data; grants proven effective as-role; smoke test proves exit 2 without disabling `-e`; no test can pass without executing its assertion.
8. **Report.** Deliver root cause per failure, exact changed files + rationale, regression tests, exact commands run with results, and any unresolved issues with severity. Do not commit, push, or claim CI green — green requires the next Actions run after the owner publishes.

## Validation plan

- `npm run test:phase0:unit` — green, including the three new regression tests; each new test demonstrated to fail on pre-fix code (stash-check or targeted revert).
- `npm run typecheck` and `npx tsc -p phase0/tsconfig.json --noEmit` — green.
- No-weaken audit via diff inspection: P1/P3/backpressure, vault baseline, ownership teardown, NOLOGIN design, sys/app pool split, and `probe-web.mjs` fail-closed behavior all unchanged.
- Not run locally (no Docker on this Mac, per prompt24 §2): `npm run test:phase0:integration`, the staging-apply proof, the ledger-race proof, and the Docker image build + smokes. These run on GitHub Actions after the owner publishes; the plan's completion criterion for them is the next green Actions run, not a local claim.
- Highest-risk validation: Fix A scope — confirming no local consumer needs `phase0_rt` rights on `app` tables, so that removing the bad grant neither leaves a hidden permission gap nor tempts a `public`-schema move. Settled by the consumer inspection in step 1, corroborated by the green integration job on Actions.

## Risks and boundaries

- If step 1 finds a genuine local `phase0_rt` consumer of `app` tables, the fix grows least-privilege `app` grants rather than a schema move; the staging `app` contract is never altered to satisfy local setup.
- If the static ordering test for Fix B proves too brittle, the fallback is keeping only the live double-apply proof in `verify-staging-apply.mjs`, disclosed in the report.
- No `.env` access, no secret requests, no Fly/Neon connections, no staging/production operations, no Docker install attempts, no commits/pushes/merges/deploys, no GitHub resource mutations.
- Do not rerun the failed workflow as-is before the fixes; do not proceed to Fly/Neon staging T1–T6 — CI acceptance gates come first.
