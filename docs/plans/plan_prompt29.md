# Plan: implement docs/plans/prompt29.md — Developer workstation, CLI toolchain, Taskfile automation

## Goal

Turn the OpenLevel repo and macOS workstation into a one-command, agent-friendly dev environment: install the local toolchain (PostgreSQL, Node LTS + Node 22, Task, flyctl, Neon CLI), create a root `Taskfile.yml` as the single command interface, and deliver `task dev` as the one command that starts the real React/Vite UI + Hono API, waits for readiness, prints URLs and demo credentials, and opens the browser. No CI/runtime changes, no cloud auth, no deploys, no commits or pushes.

## Verified starting state

- Branch `phase0/p2-staging-readiness` @ `983c774`; tree clean except untracked `docs/plans/*` files including `prompt29.md`. No `Taskfile.yml`, no `AGENTS.md`, no `docs/development/`, no `.nvmrc` / `.node-version`. No existing `Taskfile` reference anywhere except `prompt29.md`.
- `package.json` engines `node >= 22.0.0`; CI pins `NODE_VERSION: "22"` (`.github/workflows/phase0.yml:23`); CI P2 boot-proof uses service `postgres:16.16` (`phase0.yml:101`).
- All prompt29-listed scripts verified present: `dev` (vite), `dev:server` (`tsx watch server/index.ts`), `dev:local` (`tsx watch server/dev-server.ts`), `build`, `migrate`, `seed`, `typecheck`, `test`, `test:phase0:unit`, `test:phase0:integration`, `test:env:up/down`. Plus unlisted `test:phase0`, `test:watch`, and `shoot` — whose target `scripts/shoot.mjs` is **missing** (pre-existing gap; `scripts/` has no such file).
- `server/dev-server.ts`: in-memory PGlite, applies `db/schema.sql` verbatim, `seedDatabase`, canned Claude stub + fake Chatwoot sender, API on `:8790`, login `admin@acmecorp.com / openlevel`. `vite.config.ts`: frontend `:5273`, proxies `/api` → `localhost:8790`. Health endpoint is `GET /health` → `{ok:true}` (`server/index.ts:107`).
- `db/migrate.ts` and the `db/seed.ts` CLI entry both require `DATABASE_URL`; `seed.ts` is import-safe for dev-server. `.env.example` sets the local-DB convention `postgres://openlevel:openlevel@localhost:5432/openlevel`.
- `phase0/p2/fly.staging.toml` is the isolated P2 proof (`app = "openlevel-p2-staging"`); no root `fly.toml` exists.
- App routes: `/login`, index redirects to `/assistant` (`src/App.tsx`, `src/features/auth/LoginPage.tsx`) — the UI verification targets.
- `docs/openlevel-local-run.md` documents the manual two-terminal flow that `task dev` replaces.
- Planning sandbox `PATH` has no `node`/`npm`/`brew`/`task`/`fly`/`neon`/`psql`, so workstation toolchain state is unverified until execution-time recon on the real Mac.

## Success criteria

- `task --list` discovers every command; `task doctor` validates the machine; `task dev` starts API + UI, waits for both health checks, prints URLs + demo credentials, opens the browser, forwards logs, and shuts both processes down cleanly on Ctrl+C.
- Taskfile covers tools, deps, dev, db, test/quality, fly (read-only + guarded deploy), and neon (read-only) namespaces per prompt29 §3, reusing real scripts only — no task pointing at a nonexistent script or config.
- `package.json` engines and CI pins unchanged; local PG 18 vs CI PG 16 distinction documented, CI untouched.
- `AGENTS.md` + `docs/development/LOCAL_DEVELOPMENT.md` written; no secrets printed, committed, or copied into the Taskfile; no `.env` inspection.
- No `fly`/`neon` auth, login, link, init, launch, deploy, or remote-DB mutation executed; deployment task defined but never run.
- Verification matrix delivered with PASS / FAIL / NOT RUN (never PASS for unrun checks); exact versions, install methods, task catalog, and git diff inventory reported. No commit or push.

## Key decisions

- **D1 — `scripts/dev.mjs` launcher (Node builtins only, zero new deps).** Readiness polling, port-conflict detection, log forwarding, browser open, and graceful dual-process shutdown need real process control; Taskfile alone cannot do this cleanly. Split: `Taskfile.yml` = interface, `scripts/dev.mjs` = lifecycle.
- **D2 — Bind frontend via launcher flags (`vite --host 127.0.0.1 --port 5273`), leave `vite.config.ts` untouched.** Minimal diff; satisfies the 127.0.0.1 requirement without changing shared config. Backend stays on the existing `:8790` dev-server arrangement.
- **D3 — Project Node pin via `.nvmrc` containing `22`, if no manager conflict.** Read by both `fnm` and `nvm`; if the workstation already uses another manager (e.g. Volta), use its native mechanism instead of adding a second pin.
- **D4 — Local PG naming follows `.env.example`** (`openlevel` db/role on `localhost:5432`) only after inspecting existing clusters; create only when needed, never overwrite, never touch Neon/prod. `DATABASE_URL` lives in untracked `.env`, never echoed.
- **D5 — Exclude `npm run shoot` from the Taskfile.** Its target `scripts/shoot.mjs` does not exist (pre-existing gap); prompt29 forbids tasks referencing nonexistent scripts. Report it, do not fix it here.
- **D6 — `test:unit` maps to `npm test` (`vitest run`); `check` aggregates root typecheck + `phase0` typecheck + unit + build.** There is no separate unit script, and the Phase 0 typecheck (`npx tsc -p phase0/tsconfig.json`) is a real CI gate worth exposing even though it has no npm script.
- **D7 — `fly:deploy` requires all three of `FLY_APP`, `FLY_CONFIG` (must exist on disk), `CONFIRM_DEPLOY=yes`; validates config via the installed CLI's documented preflight; never defaults to the P2 staging config.** Defined and dry-run only — never executed.
- **D8 — All install commands and version expectations are prompt29-specified and must be re-verified against official docs at execution time** (prompt29's own rule); the plan pins no version numbers itself, and CI stays on Node 22 / PG 16 regardless of what is newest.

## Approach

Recon first on the real workstation (planning sandbox proved nothing about installed tools), then install toolchain with backup-before-edit safety, then build the Taskfile + launcher with guards baked in, then verify for real: dry-runs for audit, actual `task dev` with browser evidence, non-destructive DB checks, and the local test/typecheck/build gates. Read-only cloud CLIs are installed and wrapped but never authenticated.

## Steps

1. **Recon (prompt29 §1).** On the workstation, confirm branch, `package.json` scripts (re-verify the missing `scripts/shoot.mjs`), engines, CI pins, `db/` + `server/dev-server.ts` + `vite.config.ts` + `.env.example` (do not print `.env` itself), Fly configs, Neon arch docs (`docs/architecture/`), absence of `AGENTS.md`/`Taskfile*`/`docs/development/`, current shell + rc files (with backups before any edit), and presence/versions of `node`, `npm`, `brew`, `psql`, `task`, `fly`, `neon`, and any Node version manager.
2. **Install PostgreSQL (prompt29 §2.1).** Prompt29-specified `brew install postgresql@18` + `brew services start postgresql@18`, after verifying against current official docs at execution time; verify `psql --version` + `pg_isready`. Inspect existing clusters first; create the dedicated local dev database/role only when needed. Document local-PG vs CI-PG-16 split; touch nothing in CI.
3. **Install Node toolchain (prompt29 §2.2).** Latest LTS + Node 22 side by side via `fnm` or the existing manager; add the `.nvmrc` pin per D3; idempotent, backed-up shell-rc additions only. Verify `node --version` / `npm --version` and that the repo resolves Node 22 in a fresh terminal.
4. **Install Task, flyctl, Neon CLI (prompt29 §2.3–2.5).** Prompt29-specified installs (`go-task/tap/go-task`, `flyctl`, global `neon@latest`), verified against current official docs; verify `--version`/`--help` for each. No `fly auth login` / launch / deploy; no `neon init` / `auth` / `link` / `env pull`.
5. **Create `Taskfile.yml` (prompt29 §3).** Supported schema version per installed Task docs; root-relative paths; descriptions + namespaces per prompt29 §3.1 (adjusted per D5/D6); every task reuses a real script/command; required vars fail loudly (`FLY_APP`, `PROJECT_ID`, `DATABASE_URL`); secrets never printed; no destructive defaults; `task doctor` checks tools, Node selection, PG readiness, ports, and config presence.
6. **Implement `task dev` + `scripts/dev.mjs` (prompt29 §4, highest priority).** Launcher spawns `dev:local` backend + `vite --host 127.0.0.1` frontend; polls backend `/health` and Vite root; detects port conflicts and fails clearly instead of migrating ports; prints the URL/credential banner; opens the browser (with `NO_BROWSER`-style opt-out for automation); forwards both logs; on Ctrl+C or either-process exit, kills the other and reports. States the PGlite in-memory reset clearly.
7. **Database tasks (prompt29 §5).** `db:version/status/start/stop/create/migrate/seed/psql` against local PG only, via `db/migrate.ts` + `db/seed.ts` with `DATABASE_URL` required; guard tasks to refuse Neon/prod-looking URLs; never print connection strings; no `db:reset` unless confirm-gated and local-only. PGlite demo stays independent of the PG service.
8. **Test/quality tasks (prompt29 §6).** `typecheck`, `test`, `test:unit`, `test:phase0:unit`, `test:phase0:integration`, `build`, `check` per D6; local-first order (focused → unit → both typechecks → integration where infra allows → build); infra-blocked checks report NOT RUN; no mocking to dodge PG; no CI-gate weakening.
9. **Fly tasks (prompt29 §7).** Read-only `fly:version/apps/status/logs/releases/open` with required `FLY_APP`; guarded `fly:deploy` per D7, defined and dry-run only, never executed; doc note that owner authorization is required for any deploy/scale/secret/migration op. Re-read arch docs + P2 staging config first so nothing treats P2 staging as product config.
10. **Neon tasks (prompt29 §8).** `neon:version/help/projects/branches/diff/inspect` using the `neon` executable with syntax validated against installed `neon --help`; `PROJECT_ID` passed as a var, never hardcoded; read-only vs mutating clearly separated; no branch create/delete/reset, no migrations against Neon, no `.env` pulls.
11. **Agent docs (prompt29 §9).** New root `AGENTS.md` (none exists; 10-point command reference per prompt29) + `docs/development/LOCAL_DEVELOPMENT.md` (toolchain, compat, catalog, `task dev`, demo login, local PG, test workflow, Fly/Neon usage, local-vs-remote boundaries, port/DB troubleshooting). Explain `task --list` discovery; do not paste the whole Taskfile.
12. **Verify + adversarial review + report (prompt29 §§11–12).** Capture the §11 toolchain matrix; `task --list`, `task doctor`, `task --dry` audits for cloud ops/secrets/wrong paths; real `task dev` proving backend health, frontend response, browser open, `/login` render, demo login → `/assistant`, UI-driven API success, clean Ctrl+C (browser-automation evidence, not just HTTP 200); non-destructive DB checks (service start/stop, migrate + seed against isolated local DB, no secret leakage); local tests/typechecks/build with exact commands + results; adversarial pass over guards (P2-config confusion, prod-DB targeting, secret printing, port handling, shutdown paths); deliver the §12 package with PASS/FAIL/NOT RUN matrix and remaining owner steps. No commit/push.

## Validation plan

- `task --list` — every prompt29 §3.1 task present (minus D5 exclusion, plus D6 mappings), descriptions clear.
- `task doctor` — green on the prepared workstation; fails loudly with a useful message when a tool/config is missing (spot-check by inspecting, not by breaking the machine).
- `task --dry dev`, `task --dry typecheck`, `task --dry test:phase0:unit` — reviewed for accidental cloud ops, secrets, wrong paths/DB targets.
- `task dev` (real run) — backend `GET :8790/health` → `{ok:true}`; Vite `:5273` responds; browser opens `:5273`; `/login` renders; `admin@acmecorp.com / openlevel` signs in to `/assistant`; at least one UI-driven API call succeeds; Ctrl+C stops both processes with no orphans. Highest-risk validation: dual-process lifecycle + real browser proof.
- DB checks — `db:start/stop/status/version` work; `db:migrate` + `db:seed` succeed against the isolated local DB; diagnostics print no secrets; PGlite `task dev` unaffected by PG service state.
- `task typecheck`, `task test`, `task test:phase0:unit`, `task build`, `task check` — exact commands + results recorded; Docker/Testcontainers-gated suites (e.g. `test:phase0:integration`) honestly NOT RUN locally if infra is absent, with CI as final confirmation.
- Guard audit — `fly:deploy` without all three vars fails; with vars it is still never executed; `neon` tasks run no auth/init/link; nothing in the diff touches `engines`, CI pins, `vite.config.ts`, or existing app code beyond the new files.

## Risks and boundaries

- Local PG 18 vs CI PG 16: documented split, never resolved by changing CI. If a migration behaves differently across majors, report it; do not pin local to 16 silently either — surface the choice.
- Planning-sandbox caveat: no toolchain state was verifiable here; step 1 recon on the real Mac may find partial installs (existing manager, existing PG cluster, existing shell setup) that change D3/D4 details. Adapt, keep idempotent, back up before editing.
- `scripts/shoot.mjs` gap is out of scope (D5); screenshot evidence for `task dev` uses whatever browser automation is available at execution, not the missing script.
- No Docker install (prompt29 §10); container-backed tests stay NOT RUN locally and CI-confirmed.
- Hard boundaries: never print/inspect `.env` or secrets; never `fly`/`neon` auth or remote mutation; never deploy; never drop/recreate databases by default; never overwrite shell/project config without backup + review; never commit or push; stop after local implementation, verification, and adversarial review.
