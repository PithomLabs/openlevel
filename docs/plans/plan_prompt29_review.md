# OpenLevel Prompt 29 — Adversarial Review and Revised Muse Execution Prompt

Date: 2026-11-16
Source reviewed: `plan_prompt29.md`
Target: OpenLevel workstation and repository

---

# Part I — Independent adversarial review

## Overall verdict

**FIX BEFORE EXECUTION.** The plan's architecture and safety posture are good, but it assumes a toolchain installation path that is not compatible with the owner's confirmed operating system, macOS Monterey 12. The plan also needs to resolve the existing Muse/Documents permission problem, update stale Git starting-state assumptions, and strengthen local server binding and process cleanup requirements.

The plan should not proceed directly to `brew install`, `fnm install`, or PostgreSQL 18 installation on Monterey. First determine the Mac's hardware architecture and whether it can be upgraded to a currently supported macOS release. Do not force unsupported installs, compile large toolchains as a workaround without owner approval, or silently downgrade versions.

## Findings

### F-01 — Monterey versus current Homebrew support

**Severity: BLOCKER**

The plan treats Homebrew as the preferred package manager and implies that Monterey can be handled as an ordinary installation prerequisite. That is unsafe.

As of 2026-11-16, Homebrew's installation documentation identifies macOS Sequoia 15 or later on supported Apple Silicon hardware as its supported installation environment. Earlier macOS versions may work but are lower-tier/unsupported configurations. Monterey is not a supported Homebrew target. Homebrew's September 2026 support-tier documentation places older Apple Silicon versions, including Monterey, in Tier 3. Intel systems are also Tier 3.

The current `postgresql@18` formula's published bottle support does not include Monterey. A source build or formula workaround is not an acceptable default for a workstation bootstrap.

**Required correction:** Inspect `sw_vers -productVersion`, `uname -m`, and hardware model before installing Homebrew. If the Mac can upgrade, recommend an owner-managed upgrade to a supported macOS release before the toolchain installation. If it cannot, stop and present a separately approved Monterey-compatible installation matrix; do not pretend that Homebrew is supported.

References:
- https://docs.brew.sh/Installation
- https://docs.brew.sh/Support-Tiers
- https://formulae.brew.sh/formula/postgresql@18

### F-02 — Current Node.js binaries are not compatible with Monterey's OS floor

**Severity: BLOCKER**

The plan wants both project Node 22 and the latest Node LTS. As of 2026-11-16, Node 26.13.1 is Active LTS and Node 22.23.5 is Maintenance LTS. The current Node.js build documentation states that official macOS binaries are built with a macOS 13.5 deployment target. Monterey 12 is below that target.

Therefore, the plan must not assume `fnm install 22` and `fnm install 26` will produce runnable binaries on Monterey. Installing a version manager does not solve an operating-system deployment-target mismatch.

**Required correction:** Verify actual binary compatibility on the machine. Prefer upgrading macOS before installing current Node releases. If macOS cannot be upgraded, stop before installing a stale or unsupported Node build; present the tradeoff and obtain owner approval for an alternative runtime strategy. Keep `package.json` engines and the CI Node 22 pin unchanged.

References:
- https://nodejs.org/en/download/
- https://nodejs.org/en/about/previous-releases
- https://github.com/nodejs/node/blob/main/BUILDING.md

### F-03 — PostgreSQL 18 macOS installer floor

**Severity: BLOCKER for PostgreSQL 18 on Monterey**

PostgreSQL 18.7 is the current stable major release on 2026-11-16; PostgreSQL 19 is still a release candidate and must not be installed as a stable production version. However, the PostgreSQL macOS package page lists PostgreSQL 18's EDB installers as tested on macOS 13 or later. Monterey is macOS 12. PostgreSQL 17's EDB installer compatibility is broader and can be a fallback if the owner chooses to remain on Monterey.

**Required correction:** If the Mac remains on Monterey, do not claim PostgreSQL 18 was installed or validated. Present PostgreSQL 17.x as a possible supported fallback after checking the current EDB platform matrix, or obtain owner approval for another installation method. Clearly document the difference between local PostgreSQL and CI PostgreSQL 16.16. Do not change CI.

References:
- https://www.postgresql.org/
- https://www.postgresql.org/download/macosx/
- https://www.postgresql.org/docs/18/release-18-7.html

### F-04 — Muse cannot currently read the Documents workspace

**Severity: BLOCKER for repository execution**

The current repository path is `/Users/sherwin/Documents/openlevel/openlevel`. Muse previously returned `Operation not permitted` for the current directory, and Git itself returned the same error when asked to resolve the repository root.

This is a macOS TCC/files-and-folders access problem, not a computer-name problem. The Mac's account name and home-directory basename can legitimately differ (`whoami` returned `anton`, while `$HOME` is `/Users/sherwin`). Do not rename the home directory or change ownership to fix this.

**Required correction:** Prefer moving/copying the complete repository to a non-protected path such as `$HOME/work/openlevel`, preserving `.git`, ignored/untracked files, and the working tree. The owner can do this through Finder or grant the narrow Documents access to the actual terminal/launcher. Do not make Full Disk Access the default workaround. Start Muse from the readable workspace and verify `git rev-parse --show-toplevel` before proceeding. Do not run `muse init --force` or reinitialize a workspace merely to bypass access errors.

### F-05 — The Git starting-state section is stale

**Severity: HIGH**

The source plan says the active branch is `phase0/p2-staging-readiness` at `983c774`. That was the P2 PR head. The canonical GitHub repository has since merged PR #2 into its default branch `master`. The merge commit verified on GitHub is `708458d2e80cae4d831bc0fee5772790488a33f9`.

The canonical repository's default branch is `master`, not `main`.

**Required correction:** Treat the plan's starting SHA and branch as historical context only. On the actual Mac, inspect `git status --short --branch`, current HEAD, remotes, and the current local/remote refs. Do not switch branches, reset, rebase, clean, or discard untracked documents. Do not assume the local checkout has already been updated to the remote merge commit.

References:
- https://github.com/PithomLabs/openlevel
- https://github.com/PithomLabs/openlevel/pull/2
- https://github.com/PithomLabs/openlevel/commit/708458d2e80cae4d831bc0fee5772790488a33f9

### F-06 — Loopback binding must cover the API as well as Vite

**Severity: HIGH**

The plan explicitly binds Vite to `127.0.0.1`, but the existing local Hono API server calls `serve({ fetch, port })` without an explicit hostname. The agent must inspect the actual `@hono/node-server` behavior and prove the API binds only to loopback. If it does not, make the smallest isolated change to `server/dev-server.ts` to bind `127.0.0.1`; do not modify the production server or Vite config unnecessarily.

### F-07 — Child-process cleanup needs process-group handling

**Severity: HIGH**

Spawning `npm run` scripts and killing only the direct child can leave Vite/tsx descendants running. The launcher must either invoke the underlying Node entrypoints directly or create/terminate process groups on macOS. It must handle SIGINT and SIGTERM, clean up both process trees, wait for graceful exit, escalate to SIGKILL after a bounded timeout, and avoid orphan processes.

### F-08 — Local DB URL validation must parse, not string-match

**Severity: HIGH**

A simple check for words such as `neon`, `prod`, or `fly` in `DATABASE_URL` is not a sufficient guard. Parse the URL and require an explicit local hostname (`localhost`, `127.0.0.1`, or `::1`) and the intended local database name. Refuse all other hosts before running migrations or seeds. Never echo the URL or password.

Do not inspect `.env` manually or print it. If Taskfile loads `.env`, it must do so through a scoped environment mechanism and never include credential values in task output or diagnostics.

### F-09 — Fly P2 config must be categorically excluded from product deployment

**Severity: HIGH**

There is no root product `fly.toml`. `phase0/p2/fly.staging.toml` is an isolated P2 proof application (`openlevel-p2-staging`), not the OpenLevel product configuration.

A guarded deploy task may be defined for future use, but it must explicitly refuse `phase0/p2/fly.staging.toml`, require an existing non-P2 config path plus `FLY_APP` and `CONFIRM_DEPLOY=yes`, and never be executed during this task. Do not create a speculative product `fly.toml` or run `fly launch`.

### F-10 — Neon CLI task names and remote behavior need precise boundaries

**Severity: MEDIUM**

The current Neon CLI is installed as npm package `neon` and exposes the `neon` executable. The current CLI supports commands such as `neon projects list`, `neon branches list --project-id ...`, `neon diff`, `neon inspect db ...`, and a local-only `neon status`. Confirm command syntax from the installed CLI's own help before wrapping it.

Do not run `neon auth`, `neon login`, `neon init`, `neon link`, `neon checkout`, `neon env pull`, branch creation/deletion, migrations, or any remote write. Remote read-only commands may still require pre-existing authentication; do not initiate authentication. Keep those tasks inert until explicitly invoked by the owner.

References:
- https://www.npmjs.com/package/neon
- https://neon.com/blog/just-landed-in-the-neon-cli
- https://neon.com/docs/manage/branches

### F-11 — Browser proof must prove the actual UI, not just HTTP readiness

**Severity: MEDIUM**

An HTTP 200 from Vite and `/health` proves readiness, not successful login or application rendering. The plan correctly asks for browser proof; make it mandatory to distinguish: backend health, frontend response, actual login, authenticated app route, and at least one UI-driven API request. If no browser automation is available to Muse, report the interactive proof as `NOT RUN` and give the owner the manual verification steps. Never claim success from HTTP alone.

### F-12 — Testcontainers integration remains CI-backed

**Severity: MEDIUM**

Local PostgreSQL does not substitute for Docker/Testcontainers integration coverage. The owner does not want Docker installed as part of this task. Keep container-backed integration checks as `NOT RUN — Docker unavailable` locally and leave the GitHub Actions gates unchanged. The PGlite local UI demo remains independent of the local PostgreSQL service.

### Positive decisions to retain

- PGlite is the correct isolated local UI demo backend; `task dev` must not depend on Neon or the local PostgreSQL service.
- Keep `scripts/dev.mjs` dependency-free, using Node built-ins.
- Keep Vite at 5273 and local API at 8790 unless actual source inspection shows otherwise.
- Preserve `package.json` engines and GitHub Actions Node 22 / PostgreSQL 16.16 pins.
- Exclude `npm run shoot` from Taskfile because `scripts/shoot.mjs` is absent.
- Keep Fly/Neon unauthenticated and remote mutation disabled.
- No commits, pushes, merges, deploys, cloud operations, or secret handling.

---

# Part II — Revised Muse execution prompt

Copy the following prompt into Muse after it has opened a readable OpenLevel workspace.

---

# Prompt 29.1 — OpenLevel Workstation Bootstrap, Taskfile Automation, and One-Command Local UI

## Mission

Implement the OpenLevel developer workstation and repository automation described in Prompt 29, incorporating the compatibility and safety corrections below.

Deliver a discoverable root-level `Taskfile.yml`, a robust `task dev` launcher, developer/agent documentation, and the maximum amount of verified local toolchain setup that the actual Mac can support.

The developer uses macOS Monterey 12 and Muse. The existing repository was under Documents, where Muse/Git encountered `Operation not permitted`. Do not assume the original workspace is accessible. The developer may relocate the complete repository to `$HOME/work/openlevel` before execution.

**Do not force an unsupported toolchain install.** The first gate is OS/hardware compatibility. If the current Mac cannot run the requested current versions, stop the installation portion and report the exact incompatibility plus the owner decision required. You may still perform safe repository reconnaissance and source-level implementation if the workspace is readable and the repository's Node runtime can execute safely. Do not silently downgrade or compile unsupported runtimes as a workaround.

## Non-negotiable boundaries

- Do not inspect, display, copy, parse manually, or print `.env` contents or secrets. A program may consume a required environment variable without echoing it, but no credential values may appear in logs.
- No Fly.io or Neon authentication, login, init, link, env pull, or MCP setup.
- No cloud resources, deployments, scaling, machines, secrets, migrations, or remote database mutations.
- No `fly launch`.
- No mutation of GitHub, branches, pull requests, tags, CI, or remote repository state.
- No commit, push, merge, rebase, reset, clean, or destructive Git command.
- Do not install Docker.
- Do not ask the owner for their sudo password. The owner enters it directly into macOS prompts when necessary.
- Do not change `package.json` engines, GitHub Actions pins, CI PostgreSQL version, `vite.config.ts`, or production runtime configuration without a proven requirement and explicit approval.
- Preserve all pre-existing modifications and untracked documents. Never use `git add -A`.
- Never describe `NOT RUN` as `PASS`.

## Phase 0 — Workspace access and Git safety gate

Before inspecting or modifying repository files:

1. Confirm the current directory is readable by the Muse process.
2. Run `pwd -P`, `git rev-parse --show-toplevel`, `git status --short --branch`, `git log -1 --oneline`, and `git remote -v`.
3. If the current workspace is under Documents and returns `Operation not permitted`, stop. Ask the owner to move/copy the complete repository through Finder to `$HOME/work/openlevel` or grant narrow Documents access to the actual terminal/Muse launcher. Do not default to Full Disk Access.
4. Verify the copied repository preserves `.git`, current branch, uncommitted changes, ignored files needed for development, and untracked planning notes. Use no destructive copy/cleanup. Do not assume account name equals home-directory basename; use `$HOME`.
5. Do not switch branches. Inspect current local refs and remotes. The old plan's `983c774` is historical P2 branch context. On GitHub, PR #2 was merged into canonical `master` at `708458d2e80cae4d831bc0fee5772790488a33f9`; do not assume the local checkout has fetched or checked out that commit. Canonical default branch is `master`, not `main`.
6. If the workspace remains inaccessible, provide exact owner-side recovery steps and stop without edits.

## Phase 1 — macOS and hardware compatibility reconnaissance (mandatory)

Capture only non-secret system metadata:

```bash
sw_vers -productVersion
sw_vers -buildVersion
uname -m
uname -a
printf '%s\n' "$SHELL"
printf '%s\n' "$HOME"
xcode-select -p 2>/dev/null || true
xcodebuild -version 2>/dev/null || true
```

Identify Mac model and processor using `system_profiler SPHardwareDataType` but do not collect serial numbers or hardware UUIDs into reports. Determine whether this hardware officially supports an upgrade to macOS Sequoia 15 or later.

Check installed command availability and versions without assuming the planning sandbox's PATH reflects the real Mac:

```bash
command -v brew node npm fnm nvm task psql pg_isready fly neon port || true
```

Also inspect available disk space and current PostgreSQL services without modifying them.

### Known compatibility facts as of 2026-11-16

- Homebrew's supported Apple Silicon installation target is macOS Sequoia 15 or later; Monterey is outside the supported tier and must not be treated as a normal Homebrew installation target.
- Current official Node.js macOS binaries have a macOS 13.5 deployment target. Monterey 12 is below this.
- Current Node.js releases: 26.13.1 is Active LTS; 22.23.5 is Maintenance LTS. The project must continue to run Node 22 to match CI until a separate runtime upgrade is approved.
- PostgreSQL 18.7 is the current stable major release. PostgreSQL 19 RC2 is not a stable release.
- PostgreSQL 18 EDB macOS installers are tested on macOS 13 or later; PostgreSQL 17 has a broader macOS compatibility matrix and may be the fallback if the owner chooses to remain on Monterey.
- GitHub Actions currently pins Node 22 and P2 service PostgreSQL 16.16. Do not change either.

### Installation decision gate

If the Mac is still on Monterey:

1. Do not run `brew install`, `fnm install` for current Node binaries, or PostgreSQL 18 installation as if compatibility were assured.
2. Produce a compatibility table for this exact hardware and OS.
3. If the Mac can upgrade to a supported OS, recommend that the owner perform the macOS upgrade separately. Do not start an OS upgrade or reboot.
4. If the Mac cannot upgrade, propose alternatives with exact tradeoffs: compatible PostgreSQL 17.x or 16.x binaries; standalone signed/checksummed CLI binaries where their macOS minimum supports Monterey; and a Node strategy that is both supported and receives security updates. Do not install an EOL Node runtime or claim current Node 22/26 compatibility without a successful runtime check.
5. Stop the system-tool installation stage and ask for the owner's decision if the requested current toolchain cannot be safely installed.

It is acceptable to continue source-level Taskfile/launcher/documentation work if a working Node 22 runtime is already available and verified. Otherwise do not attempt runtime validation or claim `task dev` passed.

## Phase 2 — Repository reconnaissance

Verify against the actual accessible working tree, not the old ZIP or assumptions:

- `package.json`, engines, every npm script, and lockfile.
- `.github/workflows/phase0.yml` runtime/database pins.
- `server/dev-server.ts`, `server/index.ts`, `vite.config.ts`, `src/App.tsx`, login flow, and health route.
- `db/schema.sql`, `db/migrate.ts`, `db/seed.ts`, `.env.example` (do not read `.env`).
- Existing AGENTS files, Taskfiles, docs, scripts, Fly config files, architecture documents.
- Whether `scripts/shoot.mjs` exists; if still missing, do not create a Taskfile task for it.
- Existing user modifications and untracked plan files.

Known repository design to re-verify:

- `server/dev-server.ts` boots in-memory PGlite, applies `db/schema.sql`, seeds demo data, and uses canned/stubbed integrations.
- API health endpoint: `GET /health` on port 8790.
- Vite frontend on port 5273 proxies `/api` to `http://localhost:8790`.
- Demo login: `admin@acmecorp.com` / `openlevel`.
- The local PGlite demo is ephemeral and resets on restart; it is independent of local PostgreSQL and Neon.
- `phase0/p2/fly.staging.toml` is a dedicated P2 proof app, not a product deployment configuration. No root product `fly.toml` was present in the prior reconnaissance; re-check.

Record any divergence before implementation.

## Phase 3 — Toolchain installation, only after compatibility approval

Install only after Phase 1 establishes compatibility and any owner-required OS upgrade is complete.

Preferred versions on a compatible OS:

- Node 22 latest patch for OpenLevel project execution (retain CI parity).
- Latest stable Node LTS alongside Node 22 for general use.
- PostgreSQL 18 latest stable patch (not PostgreSQL 19 RC).
- Task CLI latest stable.
- Fly CLI latest stable.
- Neon CLI latest stable (`neon` package/executable, not legacy `neonctl`).

Use Homebrew only if the actual OS/architecture is supported or the owner explicitly accepts its unsupported tier. Otherwise use official platform binaries/installers and verify signatures/checksums and macOS minimum requirements. Do not use an unverified `curl | sh` pipeline.

For Node:
- Prefer `fnm` only after verifying it supports the Mac OS and the Node binary can execute.
- Keep the repository pinned to Node 22 using one version file (`.nvmrc` if fnm/nvm is selected; otherwise the chosen manager's native pin). Do not create competing version files.
- Do not change the package engine or CI Node 22 pin.

For PostgreSQL:
- Inspect existing installations, clusters, services, ports, and data directories before installing or starting anything.
- Never overwrite, reinitialize, drop, or migrate an existing cluster without explicit owner approval.
- If Monterey requires PostgreSQL 17.x/16.x instead of 18.x, document the deviation and await owner approval.
- Preserve CI's PostgreSQL 16.16 as-is.

For Task and Fly CLI:
- Use official maintained Homebrew packages only on a suitable supported platform; otherwise inspect official release binaries and checksums.
- Verify `task --version`, `fly version`, and help output.

For Neon CLI:
- Install package `neon` or an official standalone binary only if its runtime/OS requirements are met.
- Verify `neon --version` and `neon --help`.
- Do not authenticate.

Record exact versions, source URLs, checksums/signature verification method, and any unsupported-tier warnings.

## Phase 4 — Root Taskfile

Create a root `Taskfile.yml` using the installed Task CLI's supported schema version. It is the single entry point for developers and coding agents.

Required discovery:

```bash
task --list
```

Required top-level tasks:

```text
default
help
doctor
tools:versions
tools:check
deps:install
deps:audit
dev
dev:api
dev:web
dev:health
dev:open
db:version
db:status
db:start
db:stop
db:create
db:migrate
db:seed
db:psql
test
test:unit
test:integration
test:phase0
test:phase0:unit
test:phase0:integration
typecheck
build
check
fly:version
fly:apps
fly:status
fly:logs
fly:releases
fly:open
fly:deploy
neon:version
neon:help
neon:status
neon:projects
neon:branches
neon:diff
neon:inspect
```

Every task must have an accurate description and point to a verified binary, package script, or existing configuration. Do not invent commands or wrap missing files.

- `default` should show help/task list.
- `doctor` reports required tools, versions, selected project Node, local PostgreSQL status, port availability, expected files, and optional cloud CLI availability. It must not authenticate or contact cloud APIs.
- Distinguish required development prerequisites from optional PostgreSQL service and cloud CLIs. A stopped optional database is a warning unless the chosen task needs it.
- Do not print environment values or secret-bearing command arguments.
- Use repository-root-relative paths; no absolute `/Users/...` paths in Taskfile.

## Phase 5 — One-command local UI: `task dev`

Implement `scripts/dev.mjs` using Node built-ins only, and expose it through `task dev`.

It must launch:

- Backend: existing `npm run dev:local` / `server/dev-server.ts` (PGlite, in-memory).
- Frontend: Vite on `127.0.0.1:5273`, with strict port use so conflicts fail clearly rather than silently shifting ports.

The API must also bind to `127.0.0.1`. Inspect Hono node-server defaults; if current behavior is not loopback-only, make the smallest isolated change to the development-only server and add an appropriate test. Do not alter the production `server/index.ts` behavior.

Launcher requirements:

1. Check both required ports before startup. If either is occupied, identify which one and show a safe diagnostic; never kill an unknown process automatically.
2. Start both children with forwarded stdout/stderr and clear `[api]` / `[web]` prefixes if practical.
3. Poll `GET http://127.0.0.1:8790/health` and the Vite URL until ready, with a bounded timeout and readable errors.
4. Detect an early child exit; terminate the sibling process tree and report the failing exit code.
5. Once both services are ready, print URLs and demo credentials; open the browser using macOS `open` only after readiness.
6. Provide `NO_BROWSER=1` for automation/headless execution.
7. Handle Ctrl+C/SIGINT and SIGTERM. Terminate complete child process groups or invoke direct entrypoints so no npm/Vite/tsx descendants remain. Wait a bounded grace interval, then force-kill the process group if necessary.
8. Make cleanup idempotent; handle repeated signals safely.
9. Avoid shell interpolation and do not leak secrets into logs.
10. Explain that PGlite data is in memory and resets on every restart.

Expected banner:

```text
OpenLevel Local Development
API       http://127.0.0.1:8790
UI        http://127.0.0.1:5273
Health    http://127.0.0.1:8790/health

Demo Login
Email     admin@acmecorp.com
Password  openlevel

Opening OpenLevel in your browser...
Press Ctrl+C to stop.
```

Do not claim the interactive UI works based only on HTTP 200.

## Phase 6 — Local PostgreSQL tasks and guards

PGlite `task dev` must not depend on PostgreSQL service state.

Expose local PostgreSQL tasks only when a compatible local server is installed:

```text
db:version
db:status
db:start
db:stop
db:create
db:migrate
db:seed
db:psql
```

Reuse `db/migrate.ts` and `db/seed.ts`.

Before migrate/seed/psql, validate the parsed `DATABASE_URL`:

- Scheme must be PostgreSQL.
- Host must be exactly `localhost`, `127.0.0.1`, or `::1`.
- Database name must equal the configured local development database (default `openlevel`).
- Reject all other hosts, including Neon, Fly/private hosts, and unknown DNS names.
- Never echo the connection string, username, or password.
- Do not run `dropdb`, `DROP DATABASE`, `initdb`, `pg_resetwal`, or destructive reset operations.
- `db:create` must check for existing role/database and create only missing objects, with password entry handled interactively and hidden; do not hardcode passwords into Taskfile or scripts.
- No default `db:reset` task.

If `.env` is used for loading `DATABASE_URL`, load only through a supported dotenv mechanism scoped to the relevant tasks. Never manually display or inspect `.env` contents. Never export the complete environment in diagnostics.

## Phase 7 — Tests and quality tasks

Map only to verified scripts:

- `test` → existing full Vitest run (`npm test`).
- `test:unit` → existing full Vitest run if no separate unit script exists; describe accurately.
- `test:phase0:unit` → `npm run test:phase0:unit`.
- `test:phase0:integration` → `npm run test:phase0:integration` (Testcontainers-backed; report `NOT RUN` if Docker is unavailable).
- `test:integration` → only if an actual corresponding script/task exists; otherwise do not advertise it or make it a helpful alias to a verified integration command.
- `test:phase0` → only if the existing script is verified.
- `typecheck` → root `npm run typecheck` plus `npx tsc -p phase0/tsconfig.json --noEmit`.
- `build` → existing build script.
- `check` → relevant local-first aggregate; must not silently omit a failing constituent task.

No CI gate changes. No Docker installation.

## Phase 8 — Fly CLI tasks

Inspect the canonical architecture docs and every Fly config before exposing tasks.

Read-only task definitions may include:

```text
fly:version
fly:apps
fly:status FLY_APP=...
fly:logs FLY_APP=...
fly:releases FLY_APP=...
fly:open FLY_APP=...
```

Some read-only Fly operations require pre-existing authentication. Do not initiate it. The task should fail with the CLI's authentication message if not already authenticated; do not try to log in.

A guarded generic deploy task may be defined for future use but must never be executed:

```text
fly:deploy FLY_APP=... FLY_CONFIG=... CONFIRM_DEPLOY=yes
```

Requirements:

- Require explicit `FLY_APP`, `FLY_CONFIG`, and `CONFIRM_DEPLOY=yes`.
- Require config file to exist.
- Refuse `phase0/p2/fly.staging.toml` categorically.
- Do not default to any application, region, config, or machine.
- Validate config using the exact installed CLI's documented validation command, after verifying syntax from `fly help`.
- Do not run deployment, launch, scale, machine, secrets, release, or migration operations in this task.
- Document that separate owner authorization is required for any future deployment or operational action.

Do not create a speculative root product `fly.toml`.

## Phase 9 — Neon CLI tasks

Use the current `neon` executable. Confirm all syntax from `neon --help` and relevant command help; do not rely on legacy `neonctl` examples.

Provide:

- `neon:version`
- `neon:help`
- `neon:status` (local context/status only, no network if documented)
- `neon:projects` (remote read-only; may require existing auth)
- `neon:branches PROJECT_ID=...` (remote read-only; must require explicit project ID)
- `neon:diff` (read-only schema diff; requires appropriate context/auth)
- `neon:inspect` (read-only diagnostics; require valid documented arguments)

Do not hardcode project or branch IDs. Do not print connection strings. Do not authenticate, link, checkout, pull env, initialize, create/delete/restore branches, apply configuration, or run migrations.

Distinguish local-only `neon status` from remote API commands that may require pre-existing authentication. Do not initiate auth when a command reports not authenticated.

## Phase 10 — Agent instructions and documentation

Create or extend root `AGENTS.md`, preserving all existing guidance. Add:

1. Run `task --list` to discover commands.
2. Run `task doctor` before substantial development.
3. Use `task dev` for the local UI/API.
4. Use Taskfile tasks for tests, typechecks, builds, and local DB operations.
5. Follow Local-First, CI-Confirmed verification.
6. Report `PASS`, `FAIL`, `NOT RUN` honestly.
7. Never inspect/print `.env` or secrets.
8. Never use Neon/Fly in local tests.
9. No deployments or remote DB mutations without separate owner authorization.
10. Do not invent commands when a Taskfile task already exists.

Create `docs/development/LOCAL_DEVELOPMENT.md` covering:

- OS/toolchain compatibility and the actual installed versions.
- Node 22 project pin and latest LTS availability.
- PostgreSQL local version versus CI PostgreSQL 16.16.
- Taskfile discovery and catalog.
- `task dev`, ports, PGlite behavior, demo login.
- Local PostgreSQL database setup and safety restrictions.
- Local-first test order and Docker/Testcontainers NOT RUN behavior.
- Fly and Neon CLI commands and authentication/deployment boundaries.
- Troubleshooting permissions, ports, Node selection, and local PostgreSQL.

Do not duplicate the entire Taskfile in the docs.

## Phase 11 — Local-first verification

Run only after all necessary runtime prerequisites are verified on the actual Mac.

### Toolchain

Capture actual results, where compatible:

```bash
sw_vers -productVersion
uname -m
node --version
npm --version
psql --version
pg_isready
task --version
fly version
neon --version
```

### Taskfile

```bash
task --list
task doctor
task --dry dev
task --dry typecheck
task --dry test:phase0:unit
```

Inspect dry-run output for cloud calls, secrets, incorrect paths, or wrong database targets.

### Development server

```bash
task dev
```

Verify:

- API `/health` returns success.
- Vite responds on loopback.
- Both processes bind loopback only.
- Browser opens the frontend after readiness.
- `/login` renders.
- Demo login succeeds and redirects to `/assistant`.
- At least one UI-driven API call succeeds.
- Ctrl+C stops both process trees and frees both ports.
- A second start works normally.

If Muse has no browser automation, report login/render/API interaction as `NOT RUN` and give manual owner steps; do not invent proof.

### Database

Run status/version first. Only if a dedicated local database is confirmed and correctly guarded, test non-destructive migration/seed. Do not reset existing data. Keep the PGlite demo independent.

### Quality

Run focused checks, unit suite, root typecheck, Phase 0 typecheck, build, and available integration checks. Testcontainers checks remain `NOT RUN — Docker unavailable` locally.

## Phase 12 — Adversarial review

Review the final diff and task definitions for:

- No secrets or `.env` values in output or tracked files.
- No broad filesystem permission changes.
- No changes to package engines or CI pins.
- No unintended changes to `vite.config.ts` or production server.
- Both dev servers bind to loopback.
- No port-stealing or auto-killing unknown processes.
- No child-process orphans after Ctrl+C, SIGTERM, or child failure.
- DB URL parser refuses every non-loopback host.
- P2 Fly config is categorically excluded from product deploy.
- Neon and Fly tasks do not authenticate or mutate anything implicitly.
- No task points to a nonexistent script/config.
- All untracked documents and existing user changes are preserved.

## Deliverables

Report:

1. macOS version, CPU architecture, model family (no serial/UUID), and workspace path.
2. Compatibility decision and any owner action required before installing tools.
3. Installed tool names, exact versions, and verified installation methods.
4. Files added/changed and exact diff inventory.
5. Taskfile task catalog.
6. `task dev` lifecycle evidence, including browser proof or explicit `NOT RUN`.
7. Local DB verification evidence without connection strings.
8. Local-first verification matrix with exact commands and PASS/FAIL/NOT RUN.
9. Adversarial findings and remaining risks.
10. Explicit list of manual actions still requiring owner approval.

Do not commit, push, merge, tag, deploy, authenticate, or mutate remote infrastructure. Stop after local implementation, verification, and adversarial review.

## Definition of Done

On a compatible and prepared workstation, the owner can run:

```bash
task --list
task doctor
task dev
```

`task dev` launches the actual OpenLevel React UI and local Hono/PGlite API, opens the browser, prints demo credentials, and leaves no child processes after Ctrl+C.

If Monterey prevents installing current Node/Homebrew/PostgreSQL versions, the agent must report that incompatibility precisely and stop the blocked installation stage instead of making unsupported changes. Repository-level work may be completed only where its runtime and verification prerequisites are genuinely available.

**Principle: One command to start. One Taskfile to remember. Local-first verification. Owner-controlled workstation upgrades and cloud operations.**

---

# Current-version evidence checked for this review

- Homebrew installation/support tiers: https://docs.brew.sh/Installation and https://docs.brew.sh/Support-Tiers
- Homebrew PostgreSQL 18 formula: https://formulae.brew.sh/formula/postgresql@18
- Node.js current downloads and release schedule: https://nodejs.org/en/download/ and https://nodejs.org/en/about/previous-releases
- Node.js build platform/deployment target: https://github.com/nodejs/node/blob/main/BUILDING.md
- PostgreSQL current release: https://www.postgresql.org/
- PostgreSQL macOS packages/platform matrix: https://www.postgresql.org/download/macosx/
- Task CLI installation: https://taskfile.dev/docs/installation
- Fly CLI installation: https://fly.io/docs/flyctl/install/
- Neon CLI: https://www.npmjs.com/package/neon and https://neon.com/blog/just-landed-in-the-neon-cli
