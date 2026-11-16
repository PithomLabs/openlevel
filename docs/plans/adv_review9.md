# Adversarial Code Review 9 — OpenLevel Cross-Platform Taskfile and Local Development

Date: 2026-11-16. Read-only review per `docs/plans/prompt30.md`. No repository files were modified by the review itself.

**Verdict: REJECT** — one P1 (documented port overrides silently break `task dev`) plus four P2s need a narrow fix pass. No files were modified; this was read-only.

## A. Executive verdict

**REJECT.** The Task 3.54 global-variable fix is genuinely correct, the EPERM distinction works, the IPv6/DB guard is solid (24/24 URL cases verified live), and every Fly/Neon/DB refusal path fails closed. But `task dev API_PORT=…` — a documented first-class override — is accepted by the launcher and then ignored by the API it spawns, producing a 90-second misleading TIMEOUT instead of a working session. That is the review brief's own §2 failure condition ("a documented command-line override is silently ignored"), so I cannot approve. The default-port path is coherent, and all fixes are small, but acceptance now would bless a known-broken documented feature.

Baseline: branch `phase0/p2-staging-readiness`, commit `983c774a847baca7dd941217c85ee18687f5bf62`. Tracked changes: `server/dev-server.ts` hostname hardening (in-scope); `CLAUDE.md` deleted (notes pointer, unrelated to this iteration — owner should confirm/restore separately). Iteration files are untracked additions: `Taskfile.yml`, `scripts/dev.mjs`, `scripts/toolchain.mjs`, `scripts/db-service.mjs`, `.nvmrc`, `AGENTS.md`, `docs/development/*`. No changes to `package.json`, lockfile, CI, or deployment config. Verified with bootstrap Node v22.23.5 + Task 3.54.0 from `/tmp/ol22` (checksums re-verified against `SHASUMS256.txt`/`task-checksums.txt`); nothing installed.

## B. Findings

**P1-1 — API_PORT/LOOPBACK overrides break `task dev` (documented override silently ignored).**
Files: `Taskfile.yml:106` (`dev`/`dev:health`/`dev:open` env mapping), `server/dev-server.ts:101` (`const port = 8790`, `hostname: '127.0.0.1'` hardcoded), `vite.config.ts:12` (proxy `http://localhost:8790` hardcoded). Only `scripts/dev.mjs` reads `OPENLEVEL_*` (proven by repo-wide search). Impact: `task dev API_PORT=8899` checks 8899 free, spawns the API on 8790, health-checks 8899 → 90s `TIMEOUT` then kills both; `dev:health` disagrees with reality; only `WEB_PORT` actually works despite "Override ports per run when needed." `dev:api` has no env mapping at all. Existing tests missed it because no test exercises overrides end-to-end (and live dev can't run in the sandbox). Fix: read/validate `OPENLEVEL_API_PORT`/`OPENLEVEL_HOST` in `dev-server.ts` (fallback 8790/127.0.0.1) and `OPENLEVEL_API_PORT` in `vite.config.ts` proxy target (env is inherited through the launcher's spawn); or refuse non-default values loudly. Introduced in this iteration (new override surface + docs claim, never wired).

**P2-1 — Non-EPERM bind errors still misreported as "already in use."**
File: `scripts/dev.mjs:110` (`checkPortFree`; same pattern in `scripts/toolchain.mjs:160`). Only `EACCES`/`EPERM` get accurate messages; `EADDRNOTAVAIL` (e.g. `LOOPBACK` set to a non-local IP) and `unknown` fall through to "already in use… Stop the other process" — the exact misdiagnosis the EPERM fix was meant to eliminate, still telling users to kill unrelated processes. No test binds with a bad address. Fix: classify `EADDRNOTAVAIL` (and default) as "cannot bind (code)" distinct from `EADDRINUSE`. This iteration; the reported fix was partial.

**P2-2 — Vite proxy prefers ::1 while the API is now 127.0.0.1-only.**
Files: `vite.config.ts:12`, `server/dev-server.ts:103`. Measured on this host: Node resolves `localhost` to `::1` first (verbatim order). The proxy therefore dials `[::1]:8790` first; it works on Node 22 only via `autoSelectFamily` fallback, adds a refused-attempt per connection, and would silently use a *wrong* server if anything ever listens on `[::1]:8790`. Previously the API was dual-stack so this was harmless — the hostname-hardening edit introduced the fragility. No test covers proxy routing. Fix: proxy target `http://127.0.0.1:…`. Regression risk from this iteration.

**P2-3 — Unquoted shell expansion in Fly tasks.**
File: `Taskfile.yml:350` (`fly deploy -a $FLY_APP -c $FLY_CONFIG`), plus template-in-quotes `-a "{{.FLY_APP}}"` at lines 312/321/330/339 (breakable via embedded `"`). Values with spaces/metachars split or inject into the highest-stakes command in the file. Tests only use simple values. Fix: `env: FLY_APP/FLY_CONFIG` + `fly deploy -a "$FLY_APP" -c "$FLY_CONFIG"` (quoted expansion is safe); same for read tasks. This iteration.

**P2-4 — LOOPBACK override unvalidated; breaks the loopback-only guarantee.**
Files: `Taskfile.yml:14`, `scripts/dev.mjs:44`. `task dev LOOPBACK=0.0.0.0` binds Vite to all interfaces while docs state unconditionally "Both processes are loopback-only." No validation anywhere. Fix: refuse non-loopback `OPENLEVEL_HOST` (or restrict to 127.0.0.1/::1/localhost). This iteration.

**P3-1 — `task check` can never pass while the pinned vault failure exists.** `check` runs `test` first with no baseline tolerance (CI has `baseline-gate.mjs`; local doesn't), so typecheck/build never run and docs don't mention it. Daily-use aggregate gate is red on a clean tree. Fix: document, or wire the baseline gate locally.

**P3-2 — Doctor hardcodes ports.** `scripts/toolchain.mjs:203` probes 8790/5273 even under overrides. Advisory only. Fix: read the same env vars.

**P3-3 — No declared minimum Task version.** `Taskfile.yml` has `version: '3'` (schema) but no `requires:`; variable behavior verified on 3.54.0 only. Fix: add `requires: { task: '>=3.54.0' }` (or the true floor).

**P3-4 — Guard lives only in Task sequencing.** `db/migrate.ts`/`db/seed.ts` read `DATABASE_URL` raw, so direct `npm run migrate` with a remote URL bypasses the guard. Taskfile paths verified safe. Hardening: add an in-script guard or a shared import.

Correct areas (with evidence): global-variable resolution (CLI overrides reach both templates and env; empty/invalid values refused; single `vars:` block, no `dotenv`, no shadowing); EPERM/EACCES messaging (observed live: "cannot bind … (EPERM…)" / doctor WARN, never "occupied"); process lifecycle (detached groups, SIGTERM→10s→SIGKILL→5s, sibling cleanup, nonzero exits); readiness (real HTTP 2xx, bounded timeout, `NO_BROWSER=1` observed, browser after readiness); DB guard (all bypass attempts refused, exit 2, zero secret leakage in 24 outputs); Fly six-condition guard + Neon fail-closed paths (all observed); `check` order; POSIX-clean shell; no initdb/pg_upgrade/drop/restore, auth, cloud, or lockfile-mutating code paths (full read + grep); docs accurate on ports/health/creds/PGlite reset/`.nvmrc`=engines=CI=22/CI PG 16.16 distinction/guard semantics/owner sequence safety (3/3 source URLs live).

## C. Required-fix list

Blockers (reject reasons): P1-1, P2-1, P2-2, P2-3, P2-4. Non-blocking: P3-1…P3-4, plus note the unrelated `CLAUDE.md` deletion for owner disposition.

## D. Verification record

PASS (all observed this session): `task --list` (47 tasks, matches docs); `platform:check` (exit 0); `tools:detect` (matches host record); `tools:plan`; `tools:versions`; `doctor` (OK with optionals missing); CLI-override propagation — template (`--port 5280`) and env (`dev:health` probes override ports); invalid-port rejection; preconditions (`tools:install`, `fly:status` unset+empty, `neon:branches`); `fly:deploy` refusals ×4 (missing app, P2 config, unreadable config, missing confirm); Neon missing-CLI ×2; DB guard matrix 24 cases (5 accept incl. `[::1]`/credentials/query/encoded; 19 refuse incl. remote v4/v6, DNS, `@`-trick, `localhost.`, decimal-IP, wrong db, bad scheme, malformed, unset, Neon-style); mutating-task guard stops ×4 (`db:migrate`/`db:seed`/`db:psql`/`db:create`); `db:start`/`db:stop` owner-refusal (exit 3); `task dev` EPERM fail-closed; doctor EPERM WARN; `NO_BROWSER=1`; `typecheck` + `typecheck:phase0` (exit 0); `test:phase0:unit` (284/284); `test` (1589 passed, 1 failed — exactly the pinned `server/lib/vault.test.ts > resolveSecret…` baseline, single FAIL line); `build` (exit 0); bootstrap checksums (node + task tarballs match); installer-URL liveness (3/3); `check` order; integration fail-fast honesty (clear "is Docker running?" fatal, exit 201).
NOT RUN (honest): live `dev`/`dev:api`/`dev:web` + browser (sandbox `listen()` → EPERM, proven by probe); EADDRINUSE live path; PG-backed migrate/seed (no server); `tools:install`/`upgrade` apply paths (installing prohibited); Neon SKIPPED-on-missing-auth (no CLI); Fly apply path (no binary; deploy prohibited); any Linux runtime (no host — `ss` filter syntax unverified).

## E. Portability confidence

Demonstrated on macOS 12.7.6/x64 only. Static inspection is clean for Linux (POSIX shell, BSD/GNU-compatible flags, `platform()` branches, no arch-hardcoded downloads, init-system-aware owner commands, no brew forcing). Not demonstrated: any Linux execution, Linux `ss` output parsing, musl hosts beyond the stated glibc floor, non-Intel Macs, or Task versions other than 3.54.0. Static inspection is not a Linux runtime test.

## F. Acceptance decision

1. Task 3.54 global-variable correction correct? **Yes** — verified empirically; no nested consumer exists. Caveat: inherited env vars are ignored (only `VAR=value` CLI form works); no declared minimum version.
2. EPERM vs occupied-port distinction correct? **Partially** — correct for EPERM/EACCES, wrong for EADDRNOTAVAIL/unknown (P2-1).
3. IPv6 handling correct through `psql -h`? **Yes** — WHATWG parsing, bracket-strip only for `-h`, no bypass found.
4. DB/Fly/Neon boundaries effective? **Yes** — all refusal paths observed; marred only by fly shell quoting (P2-3).
5. Can `task dev` reliably start/stop on supported hosts? **Not accepted** — default path statically coherent but live run blocked by sandbox; override path demonstrably broken (P1-1); proxy/LOOPBACK issues (P2-2, P2-4).
6. Toolchain resolver host-compatible? **Host-aware with correct floors, not a version resolver** — concrete versions are owner-resolved from live sources, as documented. Adequate per its disclosed design.
7. Documents accurate? **Mostly** — one broken promise (port overrides), one omission (`check` vs baseline); all else reproduced.
8. Safe to accept? **No — REJECT.** Fix P1-1 + P2-1…P2-4 in a narrow pass, then re-review (ideally with one live non-sandboxed `task dev` incl. overrides, and one Linux run).

## G. Adversarial scenarios (1–20)

1 **DEFECT** (P1-1); 2 handled (child-exit watcher exits promptly, no 90s wait); 3 fixed for EPERM (observed); 4 safe (null owner, still refuses); 5 safe (sibling killed, exit 1); 6 **DEFECT** (proxy hardcoded, P1-1/P2-2); 7 safe (bounded ≤15s shutdown); 8 safe; 9 safe for npm/vite/tsx (group kill; true daemonizers would escape — none here); 10 fixed (`::1` unbracketed correctly); 11 safe (19/19 refused); 12 safe (refused); 13 safe (no auto-migrate path exists; start-refusal covers EDB-macOS only, as documented); 14 disclosed (glibc floor stated; no musl route); 15 safe (EDB route, brew optional, no forced builds); 16 safe (owner-executed; checksums re-verified); 17 unhandled-identically-everywhere (PATH order is owner's; plan's `verify` steps surface it — acceptable); 18 safe (SKIPPED/fail-closed); 19 safe (dual P2 refusal observed); 20 safe (doctor OK, dev independent of optionals).
