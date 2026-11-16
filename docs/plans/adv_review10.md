# Adversarial Re-Review 10 — OpenLevel Remediation After Review 9

Date: 2026-11-16. Read-only re-review per `docs/plans/prompt32.md`. No repository files were modified by the review itself.

**Verdict: APPROVE WITH FINDINGS** — all five rejection findings are independently verified fixed with runtime evidence; one new P2 (IPv6 launcher URLs) and one P3 (type-gate gap) plus environmental proof gaps remain. Nothing was modified; read-only throughout.

## A. Executive verdict

**APPROVE WITH FINDINGS.** Every original defect is gone by behavior, not just by tests: the API demonstrably binds `127.0.0.1:8899` under override, the Vite proxy demonstrably follows it, hostile Fly values demonstrably arrive as single argv, and non-loopback hosts are refused in launcher, API, and Vite alike. The one new P2 breaks only explicitly-IPv6 sessions (cryptic probe crash, and orphaned children in run mode) while the default IPv4 workflow is fully verified; that is a required follow-up, not a reason to hold five proven fixes hostage.

Note: prompt32 names `adv_review9(3).md`; the file on disk is `adv_review9.md` (the REJECT with P1 + 4xP2). Same content; no other candidate exists.

## B. Original finding disposition

| Finding | Verdict | Evidence |
|---|---|---|
| P1-1 — API port override | FIXED | All 5 dev tasks map `OPENLEVEL_*` env; launcher resolves/normalizes/propagates; real API code prints `listening on 127.0.0.1:8899` under override (bundled run, then sandbox EPERM); real Vite config via Vite's loader yields proxy `http://127.0.0.1:8899` + `port: 5280`; `build` returns `server: null` even with garbage env; invalid values rejected pre-spawn |
| P2-1 — Bind-error classification | FIXED | One classifier, no duplicates (grep); 9-case matrix run live — only `EADDRINUSE`→in-use, hostile shapes (null/`{}`/numeric/lowercase)→unknown; both callers map kinds to distinct messages; live EPERM observed in `dev` and doctor |
| P2-2 — Vite proxy target | FIXED | Loader-resolved serve config: default exactly `http://127.0.0.1:8790`; follows API port; `::1`→`http://[::1]:8790`; host matches API listener in all 3 probed combos |
| P2-3 — Fly/Neon shell safety | FIXED | Zero `{{.}}` outside `env:` lines; stub-`fly` end-to-end: `x"y $(touch …) a;b\`id\`` arrived as one verbatim argv3, spaced config path as one argv5, sentinels absent; quoted preconditions refuse-empty/pass-nonempty; P2 + confirm refusals re-observed |
| P2-4 — Loopback enforcement | FIXED | `0.0.0.0`/`::`/external/DNS/malformed refused in launcher (pre-spawn, exit 1), API (pre-PGlite, exit 2), Vite serve (config throw); allowlist is exactly `127.0.0.1`/`::1`/`localhost`→`127.0.0.1` |

Two honesty bounds: no live API↔proxy HTTP request was possible (sandbox `listen()`→EPERM, re-proven), so "FIXED" means every stage verified up to the listen call through real code — not a running session. And P2-4's enforcement is fixed, but `::1` sessions then break in the launcher (new P2-N1 below).

## C. New findings

**P2-N1 — Launcher builds malformed URLs for IPv6 host; run mode would orphan both children.**
File: `scripts/dev.mjs:61` (`http://${HOST}:${API_PORT}` → `http://::1:8790`). Observed: `OPENLEVEL_HOST=::1 node scripts/dev.mjs health` → `dev: error: Invalid URL`; `dev:open` shelled `open http://::1:5273`. Root cause chain: `httpOk`'s synchronous `get()` throw rejects instead of resolving false; in `run` mode that rejection skips the `stop()` path (`cmdRun`→`main().catch`→`exit(1)`), leaving two detached children running. The `::1` URL bug pre-existed, but the remediation newly documents `::1` as supported, making it user-facing; no test covers launcher URL shape. Fix: bracket the host for URLs (one helper, reuse the `URL` object as `proxyTargetFor` does) and wrap `get()` in try/catch→`resolve(false)` as defense in depth.

**P3-N1 — Edited `vite.config.ts` and 3 new test files sit outside every typecheck gate.**
Root `tsconfig.json` includes only `src,server,db`; `phase0/tsconfig.json` only `phase0/**` (`--listFiles` confirms: only `dev-env.d.mts` is pulled in as a dependency). Current code is valid (proven by execution), so this is future-drift risk, not breakage. Fix: extend root `include` (or add a `scripts/tsconfig.json` wired into `typecheck`). Introduced by remediation (new files + newly load-bearing config).

Test-quality assessment (§9): genuine, not theater. The 16 contract tests assert properties the old tree provably lacked (old lines quoted in `adv_review9.md`); rejection tests fail against old launcher messages. Weaknesses, all closed manually in this review: the argv test proves shell semantics, not Task rendering (I proved rendering with a stub); no positive-path spawn, `vite.config`, or `dev-server` tests (I proved via esbuild-bundle + Vite loader); IPv6 launcher URLs untested (hence P2-N1).

## D. Verification record

PASS (all executed here): focused 66/66; root + phase0 typechecks (exit 0); phase0 unit 284/284; main suite 1655 passed + exactly the pinned `server/lib/vault.test.ts > resolveSecret…` failure (single FAIL line; 1655 = 1589 + 66); build (exit 0); override matrix via `dev:health` (defaults/both/explicit-defaults/empty→default); `localhost`→`127.0.0.1`; refusals (`0.0.0.0`, bogus port) via Taskfile; API bundle invalid-host exit-2 message + `listening on 127.0.0.1:8899` + `listening on ::1:8899`; Vite loader ×6 (serve defaults/overrides/IPv6, build clean/garbage-ignored, serve-garbage-throws); classifier matrix ×9; no-duplicate-classifier grep; single-source env grep; `.d.mts` resolution trace (tsc resolves the import to it; declaration matches runtime); helper edge probes ×11 (all correct); fly stub argv ×2 + sentinel absence ×3; all refusal re-checks (P2/missing-confirm/empty-app/install-gate/neon-hostile-id); `dev` EPERM + doctor EPERM messages; `NO_BROWSER=1`; DB guard accept-IPv6 + remote-migrate refusal; `tools:upgrade` preview; `task --list` (47).
BLOCKED/NOT RUN: live `dev`/`dev:api`/`dev:web` + actual proxy HTTP + browser (sandbox EPERM); EADDRINUSE live path; PG-backed chains (no server); install/upgrade apply (prohibited); Neon SKIPPED-on-no-auth (no CLI); real-fly apply (no binary); Linux runtime + `ss` parsing (no host); direct tsx execution (tsx's own worker socket gets EPERM — worked around via esbuild bundle + NODE_PATH-equivalent `/tmp/probe` layout, out-of-tree).

## E. Scope and regression assessment

Changed exactly per claim: 5 new files present, 6 edited files contain the remediation; `db-service.mjs`, `TOOLCHAIN_COMPATIBILITY.md` untouched (content + mtime); `server/index.ts`, `src/`, `db/`, `phase0/`, `package.json`, lockfile, CI untouched; no `fly.toml`/`.env` created; production behavior unchanged; build ignores dev config (proven). Deferred items intact: P3-1 (`check` still stops at baseline), P3-2 (doctor ports hardcoded, line 204), P3-3 (no `requires:`), P3-4 (`db/migrate.ts` raw `DATABASE_URL`), `CLAUDE.md` still deleted-as-was. Preserved behavior re-verified: Task 3.54 CLI precedence, lifecycle/shutdown code (byte-identical logic), genuine bounded readiness, `NO_BROWSER=1`, DB guard + bracket-strip + no-migrate-paths, owner-gated install/upgrade/deploy, Node 22 pins, PGlite independence. Nit (not a finding): the compatibility doc's dated session record still cites 1589 tests, predating the +66.

## F. Portability and evidence limitations

Demonstrated on macOS 12.7.6/x64 only. Still unverified, each needing a real host: live `dev` startup; an actual HTTP request through the Vite `/api` proxy (IPv4 and IPv6); IPv6 end-to-end (additionally blocked by P2-N1); any Linux runtime; Linux `ss` parsing; browser proof; Docker-backed suites. Static inspection was not substituted for any of these.

## G. Final acceptance decision

1. Config consistent across Taskfile/launcher/API/Vite/health/standalone tasks? **Yes for IPv4** (proven per stage); `::1` breaks launcher probes/URLs (P2-N1).
2. Can non-`EADDRINUSE` be misreported as a conflict? **No** — matrix + callers + grep verified.
3. Proxy targets the exact canonical API loopback? **Yes** — observed equal in all probed combos.
4. Fly/Neon args injection-proof? **Yes** — end-to-end stub proof, guards intact.
5. Can any supported path bind a public interface? **No** — allowlist enforced at all three layers; bypass hunt found none.
6. Helper correct at runtime, matching `.d.mts`? **Yes** — 66 tests + 11 extra edges + resolution trace + manual signature agreement.
7. Previously correct behavior preserved? **Yes** — all §10 items re-verified or diff-confirmed.
8. Safe to accept? **Yes, with findings** — accept the five fixes; require P2-N1 (IPv6 URLs + orphan path) and note P3-N1 (type-gate coverage) as follow-ups; live/Linux/IPv6-e2e proof still outstanding.
