# Plan: implement docs/plans/prompt33.md — Final release prep and GitHub publication

## Goal

Close Adversarial Re-Review 10 (fix P2-N1 IPv6 URL/orphan defect, settle P3-N1 script typecheck without scope expansion), run the final verification ladder, and package a reviewable commit of the cross-platform Taskfile/dev-workflow feature — with the owner executing all Git mutations from an exact command sheet. No commits, pushes, history rewrites, installs, cloud operations, or unrelated inclusions.

## Verified starting state

- Branch `phase0/p2-staging-readiness` @ `983c774`; tree: `M server/dev-server.ts`, `M vite.config.ts`, ` D CLAUDE.md` (preserve exactly, exclude from commit), plus the untracked 29.2/31 feature files and `docs/plans/` working docs.
- P2-N1 is LIVE, not fixed: `scripts/dev.mjs:61-63` builds `API_URL`/`WEB_URL`/`HEALTH_URL` by template literal (`http://::1:8790` malformed under IPv6); the throw path runs through `main().catch` (:301), which exits without cleanup while children are `detached` → orphans. No `uncaughtException` handler anywhere. Only `dev.mjs` constructs URLs (`toolchain.mjs`/`db-service.mjs` print hosts/ports, never URLs).
- P3-N1 is open: root `tsc` includes only `src`, `server`, `db`, so `scripts/*.test.ts`, `vite.config.ts`, and the `.mjs` helpers sit outside every type gate.
- Remotes verified (sanitized, no embedded creds): `fork` → `PithomLabs/openlevel`, `origin` → `jahfeelautomation/openlevel`. `fork/master` = `708458d` (PR #2 merge of this very branch); HEAD contributes 0 unique commits, so the local tip is fully merged and no `phase0/p2-staging-readiness` branch exists on either remote — pushing it as a new branch yields a clean single-commit PR with no rebase/merge/force. Re-fetch and re-verify at execution; refs may be stale.
- `/tmp/ol22` Node 22.23.5 + Task 3.54.0 bootstrap persists (re-verify checksums); sandbox `listen()` still EPERM (re-probe at execution).
- Owner live evidence: the owner reached `http://127.0.0.1:5273/login` in-session → record as `OWNER-REPORTED PASS`, never as agent-executed.

## Success criteria

- IPv6-safe URLs in all launcher modes (exact `http://[::1]:<port>` form), no orphan path on any startup/readiness/browser exception, IPv4 + overrides unchanged, committed regression tests green.
- P3-N1 either resolved by a small passing dedicated typecheck (no CI/package/lockfile/behavior disturbance) or retained as an explicit documented follow-up with the exact blocker — never silently claimed.
- All §4 checks executed with PASS/FAIL/NOT RUN/BLOCKED + exit codes; main suite matches the pinned vault baseline exactly (any other FAIL line is new); owner report quoted verbatim as owner-reported.
- Exact file allowlist derived by inspection (never `git add .`); `CLAUDE.md` deletion, `docs/plans/*`, secrets, and unrelated changes excluded; remote safety re-verified post-fetch; owner command sheet delivered; zero agent-executed Git mutations.

## Key decisions

- **D1 — `endpointUrl(host, port)` in `scripts/lib/dev-env.mjs`** (+ `.d.mts` signature); `proxyTargetFor` delegates to it; `dev.mjs` builds all three URLs from it. Keeps IPv6 with correct brackets (prompt31 forbids amputating it to pass tests).
- **D2 — One idempotent supervisor for all failure paths** (approved adjustment: no immediate SIGKILL from fatal handlers): `scripts/lib/proc.mjs` exports `createSupervisor(children, opts)` holding a single in-flight stop promise — `stop(reason)` runs the graceful sequence exactly once (SIGTERM → existing bounded waits → SIGKILL escalation, never rejects) and every path (`finally`, `uncaughtException`, `unhandledRejection`, signals, unexpected-exit) awaits that same promise before exiting nonzero, so concurrent triggers cannot conflict and none can skip cleanup. Plus a sync-throw guard inside `httpOk` (the throw-inside-executor path is the proven orphan mechanism).
- **D3 — Extract `killGroup`/`shutdown`/`createSupervisor` into import-safe `scripts/lib/proc.mjs`** with `scripts/lib/proc.test.ts` driving real `sleep` children (prompt kill, already-exited no-throw, SIGTERM-ignoring escalation) plus an isolated child-process fatal harness (double fault → single shutdown marker, children dead, exit nonzero). Only this makes cleanup verifiable in a socketless sandbox; `dev.mjs` keeps the child registry and routes every exit path through the supervisor. The `try/finally` wiring itself stays review-verified (stated, not tested).
- **D4 — P3-N1 as `tsconfig.scripts.json`** (`strict`, deliberately without `noUncheckedIndexedAccess` for test/glue scope, documented) + `task typecheck:scripts`, run in the ladder but NOT wired into `check`/CI/`package.json`. Disposition: local gate green = fixed-with-CI-follow-up; red-for-real-reasons = documented follow-up with the blocker.
- **D5 — Commit = 2 modified + 13 known-new + P2-N1/P3-N1 additions** (`proc.mjs`, `proc.d.mts`, `proc.test.ts`, `tsconfig.scripts.json`): 19 files total, re-derived live at execution. Excludes everything in prompt33 §5.
- **D6 — Push `fork` as a new remote branch under the current name** (verified absent remotely; ancestry already on master). Any post-fetch divergence → stop, report, no repair attempts.
- **D7 — Zero agent Git mutations** (not even `git add`); `git fetch` permitted as read-only. The staged-diff review commands go in the owner sheet for after THEY stage; the agent's pre-review uses `git diff`, `git status`, and full reads of each allowlisted file.

## Approach

Fix-verify-package in that order: land P2-N1 with failing-test-first coverage, settle the P3-N1 decision gate on evidence, run the full ladder once, then derive the allowlist and remote-safety case purely by inspection and hand the owner an executable command sheet.

## Steps

1. **Preserve + reconfirm.** Record branch/commit; `git status --short`, `git diff --stat`, full `git diff`; re-verify `/tmp/ol22` checksums; re-probe `listen()`; reconfirm P2-N1 lines live (review numbers drift). Touch nothing.
2. **P2-N1 URL fix.** Add `endpointUrl` (+ tests first: exact v4/v6 strings, `new URL` parseability, override propagation); delegate `proxyTargetFor`; rewire `dev.mjs` health/open/run URLs; add the `httpOk` sync-throw guard. Fail the new tests pre-fix, green post-fix.
3. **P2-N1 cleanup hardening.** Write `proc.mjs` (`killGroup`, never-rejecting `shutdown`, `createSupervisor` with single in-flight promise + `armFatalHandlers`) + `proc.test.ts` (real `sleep` children: prompt SIGTERM kill, exited-child no-throw, trap-ignoring escalation, fatal-harness double-fault test); rewire `dev.mjs` so signals, child-exit, `try/finally`, and fatal handlers all await the one supervisor before exiting; re-run rejection tests (invalid config still fails pre-spawn).
4. **P2-N1 mode tests.** Committed child-process tests: `health` with `::1` (bracketed dial, DOWN/DOWN, exit 1, no crash); `open` with `::1` (exit 0, bracketed URL in output); run-mode orphan coverage via `proc.test.ts` + review checklist for the fatal handler (stated as review-verified).
5. **P3-N1 gate.** Write `tsconfig.scripts.json` (scripts + `vite.config.ts`, strict minus `noUncheckedIndexedAccess`, documented); run it; fix residual errors in code only if trivial and safe, else stop and record the documented follow-up. Add `task typecheck:scripts`; do not touch `check`, CI, or `package.json`.
6. **Verification ladder.** In §4 order: `task --list`, focused config/launcher tests, contract tests, URL/cleanup tests, arg-safety tests (committed) + live stub-`fly` argv runs, both typechecks, new scripts typecheck, Phase 0 unit, main suite (FAIL line diffed against `phase0/vault-baseline.json` — exact match or NEW), build. Then live `task dev` attempt (default + `API_PORT` override + proxied `/api` request) expecting sandbox BLOCKED with probe output; record owner report verbatim as `OWNER-REPORTED PASS`.
7. **Commit packaging.** Derive the allowlist file-by-file (diff + full reads; confirm no secrets, no `CLAUDE.md`, no plans, no CI/deps/lockfile/deploy surprises, docs match code, P2-N1 disposition explicit). Do not stage.
8. **Remote + report.** Sanitized `remote -v`, `git fetch fork`, re-verify master SHA/ancestry/counts/remote-branch absence/fast-forward reading; write the §9 report (verdict, matrix, dispositions, contents, git status, owner commands, post-push checks).

## Validation Plan

- New tests fail pre-fix (URL exact-match, `::1` modes) and pass post-fix; full focused files green: `dev-env.test.ts`, `taskfile-contracts.test.ts`, `dev-rejection.test.ts`, `proc.test.ts` (incl. the isolated fatal-harness double-fault case proving single shutdown, dead children, nonzero exit).
- Stub-`fly` argv capture across hostile values shows single-argv receipt, no side effects, guards intact; deploy never beyond the stub.
- `task typecheck`, `task typecheck:phase0`, `task typecheck:scripts` (or honest follow-up), `task test:phase0:unit` (284/284), `task build` all exit 0.
- Main suite: 1655+ pass with the single FAIL line byte-matching the vault baseline entry; anything else fails the run as NEW.
- Live dev: agent-executed proof or `NOT RUN`/`BLOCKED` with the verbatim `listen()` probe; owner report quoted separately, never merged.
- Pre-commit audit: allowlist re-derived from live `status`/`diff`, every exclusion named, `CLAUDE.md` byte-identical, zero Git mutations executed (prove with `git status` before/after).
- Highest-risk validation: the live `task dev` override run, already known-blocked by the sandbox — its evidence bar is honest `BLOCKED`, and over-claiming here would invalidate the report.

## Risks and boundaries

- Stale refs could invalidate the ancestry case: mandatory re-fetch + recount at execution; on divergence, stop and report, never repair history.
- `::1` end-to-end and `EADDRINUSE`-live paths stay unit/static-only in-sandbox; the fatal-handler wiring is review-verified by construction (stated openly).
- P3-1–P3-4, `CLAUDE.md`, CI, deps, lockfile, production code, Docker, and all cloud/remote operations are hard out of scope; `task check` will still stop at the deferred baseline failure — expected, not a regression.
- Open questions: none — every material choice is settled by prompt33, the review evidence, or the workspace facts above.
