# Prompt 28 Report — M4 Ledger-Race Fix Review (adv_review8)

Review-only: nothing modified, nothing committed, pushed, or touched externally.

## A. Independent review verdict

**APPROVE WITH NON-BLOCKING FINDINGS.** The diff is exactly the intended
one-line binding correction; every placeholder/parameter pair in the script now
checks out; race ordering, all four assertions, transaction discipline, and
pool lifecycle are unchanged and correct on inspection. The reported CI failure
signature (`FATAL: there is no parameter $1` after four RACE-OKs, run
43748829440) is precisely what the pre-fix line produces, so root cause and
remedy corroborate each other. Findings are three pre-existing informationals,
none introduced by this change.

## B. Actual diff

Branch `phase0/p2-staging-readiness` confirmed. The only source change in the
working tree:

```diff
--- a/phase0/p2/ci-ledger-race.mjs
+++ b/phase0/p2/ci-ledger-race.mjs
@@ -92,7 +92,7 @@
-    await observer.query(`DELETE FROM app.p2_provider_ledger WHERE operation_id = $1`);
+    await observer.query(`DELETE FROM app.p2_provider_ledger WHERE operation_id = $1`, [op]);
```

Nothing staged, nothing else modified. Untracked files are `docs/plans/*.md`
only (prompts 24–28, two plan notes, `adv_review7.md`) — review/planning notes,
no generated artifacts, no source. The intended one-line correction is confirmed
as the sole source change; no previously reviewed file was altered.

## C. Local verification matrix

| Check | Exact command | Result | Evidence |
|---|---|---|---|
| Diff exactness | `git diff` | PASS | One line, line 95, binds existing `op`, no hardcode |
| Whitespace | `git diff --check` | PASS | Clean |
| Secrets in change | diff `grep -iE password\|secret\|token\|…` | PASS | No hits; no `.env` touched |
| `node --check` on modified file | `node --check phase0/p2/ci-ledger-race.mjs` | NOT RUN | No JS runtime: probed `node nodejs npm npx tsc tsx vitest bun deno qjs jsc` + brew/nvm/volta/opt paths — all missing |
| Focused tests for component | — | NOT RUN | None exist by design; script is CI-only (only referenced by `.github/workflows/phase0.yml:127`); prompt27 forbids replacing the DB race with a mock |
| Phase 0 unit (284 claimed) | `npm run test:phase0:unit` | NOT RUN | No node/npm; `node_modules` present but unrunnable |
| Root + Phase 0 typechecks | `npm run typecheck`, `npx tsc -p phase0/tsconfig.json` | NOT RUN | No node; statically: change is `.mjs` (outside both `tsc` programs), no signature change |
| Docker CLI / daemon | `command -v docker` | NOT RUN | Missing; per §5, not requested to install |
| Local PostgreSQL | `command -v psql pg_ctl postgres` | NOT RUN | All missing |
| Ledger-race / integration DB proofs | — | NOT RUN | Local infrastructure unavailable; must stay in CI |
| CI log inspection (run 43748829440) | `command -v gh` | NOT RUN | `gh` missing; relied on prompt27's quoted failure text |

Per the workflow: NOT RUN is reported honestly, never as PASS. All
*runnable-here* checks pass; nothing runnable fails.

## D. Adversarial findings

Full §3 checklist verified against `phase0/p2/ci-ledger-race.mjs`: all six
placeholder sites bind correctly (`$1/$2`↔`[op,…]` at lines 35, 40, 81, 90, 95;
placeholder-free statements need none); cleanup uses the run's own `op`
(`ci-race-${Date.now()}`, line 30) and runs after all four assertions; A stays
uncommitted while B blocks; the observer polls `pg_stat_activity` for
`ci-race-b` with a 30s bounded deadline (no fixed sleep) and detects `Lock`
waits or blockers; COMMIT (line 66) precedes loser evaluation (lines 69–73);
loser and sequential duplicate both require `23505`; survivor must be exactly
one row with `attempt_id='a-A'`; `a`/`b` release in nested `finally`, pools end
in outer `finally` with `.catch` guards; every `check()` failure sets
`exitCode=1` and no path converts failure to exit 0. The pre-fix crash blamed
the right line: parameterless `$1` → server `42P02` → uncaught → `FATAL` exit 1,
skipping only the PASS summary — matching the CI log exactly.

Non-blocking informationals (all pre-existing, none from this fix):

- **P28-I01:** the `!bWaiting` early return (lines 61–65) skips the final
  PASS/FAIL summary line. Cosmetic — `check()` already set exit 1, and the exit
  code is what CI gates on.
- **P28-I02:** on that same path, if B's insert errored instantly instead of
  blocking, `bAttempt` would reject unhandled. Near-unreachable (A's identical
  insert on the same table must first succeed), and the outcome would still be a
  non-zero exit. No action needed.
- **P28-I03:** same-millisecond `op` collision across concurrent runs would fail
  loudly (23505 on A's insert → FATAL), never silently corrupt; CI runs this
  once per ephemeral job. No action needed.

## E. Publication recommendation

**The developer may publish this change.** No further local step is possible or
required here. After publication, GitHub Actions must demonstrate before M4 is
considered verified: all four `RACE-OK` lines, followed by `ledger race: PASS
(constraint arbitrated, exactly one acceptance)`, job exit code 0 — plus all
other Phase 0 jobs green. Stopping here: uncommitted, unpushed, no external
infrastructure touched.
