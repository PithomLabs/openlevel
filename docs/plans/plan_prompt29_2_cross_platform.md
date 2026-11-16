# OpenLevel Prompt 29.2 — Cross-Platform, Compatibility-Aware Developer Workstation and Taskfile

Date: 2026-11-16  
Supersedes: `plan_prompt29.md` and the earlier Prompt 29.1 review/prompt  
Target OS: macOS and Linux (Intel/AMD x86_64 and ARM64 where vendor assets exist)  
Repository: OpenLevel

---

# Part I — Adversarial review and corrected decisions

## Overall verdict

**APPROVE THE DIRECTION; EXECUTE WITH A COMPATIBILITY-AWARE TOOLCHAIN RESOLVER.**

The governing requirement is not “install the newest release no matter what.” It is:

> For every supported tool, install the newest stable release that is actually compatible with the machine's OS version, CPU architecture, ABI/libc, and available vendor support. Keep OpenLevel's own runtime contract intact. If no supported compatible build exists, report the incompatibility and a safe next choice rather than silently downgrading, forcing an unsupported build, or weakening the repository.

The Taskfile itself must be portable across macOS and Linux. Installation and service-management steps may be OS-, distro-, architecture-, and version-specific. Shared development/test commands should remain shared.

## Important correction to the previous adversarial review

The earlier review incorrectly generalized the current Node.js macOS binary floor to the project's Node 22 runtime. The versioned Node.js 22.x `BUILDING.md` says that Node 22 supports macOS 11.0 or later on both x64 and arm64, and its official Darwin binaries are built with a macOS 11.0 deployment target. Therefore, Node 22 is compatible with macOS Monterey 12 at the Node platform level. Node 24/26 have a newer macOS floor (13.5), so do not require those versions on Monterey.

This is precisely why compatibility must be evaluated against the selected major-version branch and its actual release artifacts, not the latest Node.js documentation alone.

References:
- Node 22 branch build/platform matrix: https://github.com/nodejs/node/blob/v22.x/BUILDING.md
- Current Node release schedule: https://nodejs.org/en/about/previous-releases
- Node 22 latest release branch metadata: https://nodejs.org/en/download/

## Findings and decisions

### F-01 — Homebrew cannot be a mandatory bootstrap dependency

**Severity: HIGH**

Current Homebrew support tiers place older macOS releases, including Monterey, outside the fully supported tier; Intel macOS is also Tier 3 in the current policy. Homebrew may run, but package bottles and formula support cannot be assumed. Homebrew is an optional package-manager path, not the foundation of cross-platform installation.

Decision:
- Detect Homebrew if already installed and verify whether it is functioning on this host.
- Prefer a supported system package manager or official prebuilt binary when Homebrew is unsupported or lacks a compatible bottle.
- On macOS, consider MacPorts or vendor installers where the specific port/package supports the OS and architecture.
- Never force `brew install`, build large formulae from source, or alter Homebrew support settings merely to satisfy the prompt.

Reference: https://docs.brew.sh/Support-Tiers

### F-02 — Node versions must follow the repository contract and the host compatibility matrix

**Severity: HIGH**

OpenLevel's `package.json` requires Node `>=22.0.0`, and GitHub Actions currently pins Node 22. Preserve both. The repository must use the latest available patch release in the Node 22 line that is compatible with the host. Do not substitute Node 20 or another version below the engine requirement.

The separate “latest LTS” convenience is optional and host-dependent:
- Current Node release schedule identifies Node 26 as Active LTS, Node 24 and Node 22 as Maintenance LTS (as of 2026-11-16).
- macOS Monterey can use Node 22's official macOS 11.0+ builds.
- Do not install Node 24/26 on Monterey unless the selected official build is proven to support that macOS version. Current Node 24/26 builds require macOS 13.5 or later.
- On newer compatible macOS, install the newest Active LTS alongside Node 22 if useful.
- On Linux, select the newest compatible official Node build for the detected architecture and libc. The Node 22 versioned support matrix lists glibc >=2.28 for Tier 1 x64/arm64; evaluate the exact release and host ABI rather than assuming every Linux distribution qualifies.

Use the existing Node version manager if one is already present. Otherwise prefer a manager that supports macOS and Linux (for example fnm). Add a repository version file selecting Node 22 (`.nvmrc` or the existing manager's idiomatic equivalent). Ensure a fresh shell selects Node 22 within this repository.

If a host cannot execute a supported Node 22 runtime, report `BLOCKED: repository runtime unsupported on this host`; do not edit `package.json`, CI pins, or application source to lower the Node requirement. Offer a compatible host/OS upgrade or separately approved source-build route only when official requirements can be satisfied.

References:
- https://nodejs.org/en/about/previous-releases
- https://github.com/nodejs/node/blob/v22.x/BUILDING.md
- https://github.com/nodejs/node/blob/main/BUILDING.md

### F-03 — PostgreSQL major version is selected by platform support, not a universal pin

**Severity: HIGH**

Use the newest stable PostgreSQL major and patch release supported by the specific OS/architecture at execution time. Never use beta, RC, or development builds for local development.

As of 2026-11-16, PostgreSQL 18.7 is the newest stable major line. The EDB macOS installer matrix lists PostgreSQL 18 for macOS 13+ (Intel and Apple Silicon), while PostgreSQL 17 is tested on macOS 11.x for Intel and macOS 12.x for Apple Silicon. Therefore, on Monterey, PostgreSQL 17's newest stable patch is the appropriate EDB-compatible line; on macOS 13+ PostgreSQL 18 may be selected.

On Linux, prefer the PostgreSQL project's official PGDG repository when the exact distribution codename and architecture are currently supported. If the distro is too old for PGDG, use its supported native package only if the installed major is maintained and acceptable; otherwise report the fallback and ask before adding an unsupported third-party repository or building from source.

CI remains PostgreSQL 16.16. Do not change CI or claim local/CI major parity when the compatible local server is PostgreSQL 17/18.

References:
- https://www.postgresql.org/download/macosx/
- https://www.postgresql.org/download/linux/
- https://www.postgresql.org/download/linux/ubuntu/
- https://www.postgresql.org/download/linux/debian/

### F-04 — Task must install without Homebrew and without root where possible

**Severity: HIGH**

Use the official Task installation documentation. It supports macOS and Linux package managers and also publishes an installer that downloads the platform binary and verifies its checksum. Prefer a per-user location such as `~/.local/bin` when a compatible package manager is unavailable.

Taskfile schema version must declare the minimum Task CLI version required by the features actually used; do not blindly adopt the newest schema feature set.

Reference: https://taskfile.dev/docs/installation

### F-05 — Fly CLI must have a non-Homebrew path

**Severity: MEDIUM**

Use the official Fly.io `flyctl` installer or a platform/architecture-specific official release artifact on macOS and Linux. Prefer a per-user installation. Inspect downloaded installer scripts before execution and verify release checksums/signatures when published. Do not authenticate or deploy.

Reference: https://fly.io/docs/flyctl/installing

### F-06 — Neon CLI should not depend on a particular Node LTS major unnecessarily

**Severity: MEDIUM**

The current Neon CLI is installed as `neon`; the npm package requires Node >=20.19 and the package also publishes per-platform binaries. Prefer the npm package using OpenLevel's compatible Node 22 runtime when available. If that runtime/package combination is not installable on a host, inspect the official Neon release assets and use the exact matching OS/architecture binary if available. Do not use stale `neonctl` syntax as the default.

Do not authenticate, initialize, link, pull env files, or mutate remote projects.

References:
- https://www.npmjs.com/package/neon
- https://neon.com/docs/cli

### F-07 — Taskfile syntax must explicitly support macOS and Linux

**Severity: HIGH**

Use Task's `platforms` command/task selector for platform-specific pieces (`darwin`, `linux`, and architecture labels such as `amd64`, `arm64`). Keep shared tasks common. Avoid Bash-only syntax, GNU-only command flags, assumptions about `readlink -f`, or platform-specific `sed -i` behavior. Use small Node.js helper scripts for nontrivial OS differences.

The Taskfile need not support Windows for this scope. It must fail clearly on an unsupported OS instead of running Unix commands accidentally.

Reference: https://taskfile.dev/docs/guide/platforms

### F-08 — Muse workspace access is a preflight gate, not a reason to weaken macOS security

**Severity: HIGH**

The current Mac has Monterey and Muse previously could not read the repository under `Documents` because of macOS TCC permissions. Before implementation:
- Verify `pwd -P`, `$HOME`, Git root, branch, remotes, and working-tree status from a readable directory.
- Prefer the owner's copy/relocation of the complete checkout to `$HOME/work/openlevel` if Documents access continues to fail.
- Preserve `.git`, ignored and untracked files, and all working-tree modifications.
- Do not rename the home directory, change ownership, reinitialize Muse, use `muse init --force`, or grant Full Disk Access as the default remedy.

### F-09 — Git starting state must be discovered live

**Severity: HIGH**

Historical plan state (`phase0/p2-staging-readiness` at `983c774`) is not authoritative. Canonical `PithomLabs/openlevel` uses `master` as its default branch, and PR #2 was merged in commit `708458d2e80cae4d831bc0fee5772790488a33f9`. The actual local checkout may still have uncommitted or untracked files.

Inspect the live repository; preserve the current branch and all user changes. Do not fetch/checkout/reset/clean/rebase unless needed and explicitly approved.

References:
- https://github.com/PithomLabs/openlevel
- https://github.com/PithomLabs/openlevel/pull/2
- https://github.com/PithomLabs/openlevel/commit/708458d2e80cae4d831bc0fee5772790488a33f9

### F-10 — Both local app processes must be loopback-only and shut down as a process tree

**Severity: HIGH**

The API server and Vite must bind to `127.0.0.1`. The existing development Hono server does not explicitly pass a hostname; verify the `@hono/node-server` API and make the smallest dev-only change if necessary. Do not modify the production server or expose the dev API to the LAN.

The launcher must terminate child process groups, not only direct npm children; forward SIGINT/SIGTERM, wait a bounded period, escalate to SIGKILL, and leave no orphaned Vite/tsx processes. Browser launch must use `open` on macOS and `xdg-open` (or a verified fallback) on Linux.

### F-11 — Database URL guard must parse and enforce localhost

**Severity: HIGH**

Do not use substring checks alone. Parse the URI and allow only explicit loopback hosts (`localhost`, `127.0.0.1`, `::1`) and the intended local DB name/role for the task. Reject Neon, Fly, remote IPs, DNS hosts, production-looking DB names, and malformed URLs before migration or seeding. Never print `.env`, passwords, full URLs, or tokens.

### F-12 — Browser proof must exercise the real UI

**Severity: MEDIUM**

A successful health endpoint and Vite HTTP response are not sufficient. Prove the login page renders, demo credentials log in, the protected `/assistant` route renders, and a UI-driven API call succeeds. Use browser automation already available on the machine or visibly open the local UI for owner verification. Record what was actually tested; do not claim visual proof if only HTTP checks ran.

---

# Part II — Revised Muse execution prompt

## Prompt 29.2 — OpenLevel Cross-Platform Developer Workstation, Adaptive Toolchain, and Taskfile Automation

### Goal

Implement the OpenLevel developer workstation and Taskfile workflow in the actual working tree. The result must work on both macOS and Linux across different CPU architectures, libc implementations, OS versions, and package-manager availability.

The developer must not need to memorize tool commands. Agents should discover and use the same Taskfile interface on supported macOS and Linux systems.

Primary acceptance:

```sh
task --list
task doctor
task dev
```

`task dev` starts the actual local PGlite backend and Vite frontend, waits for both, prints the URLs and demo credentials, opens the UI, forwards logs, and shuts down both process trees cleanly on Ctrl+C.

### Non-negotiable compatibility policy

**Install the newest stable version that is compatible with the detected host—not the newest version regardless of compatibility.**

For each tool, resolve compatibility using:

1. OS family and exact release/version.
2. CPU architecture (`x86_64`/`amd64`, `arm64`/`aarch64`, or other).
3. ABI and runtime libraries (glibc versus musl, glibc version, kernel floor, macOS deployment target, required frameworks).
4. Official vendor support matrix for the exact tool release/major line.
5. Available official package/binary asset for the exact OS/architecture.
6. Successful post-install execution and version check.

Never infer compatibility from the package manager alone. Never assume that an installer working on a newer OS also works on Monterey or an old Linux distribution.

This request concerns the workstation toolchain (PostgreSQL server/client, Node runtime/version manager, Task, Fly CLI, and Neon CLI). It does **not** authorize upgrading OpenLevel's npm application dependencies. Preserve `package.json` and the lockfile; use `npm ci` for reproducible installs. Do not run `npm update`, regenerate the lockfile, or replace application dependencies with `@latest` as part of workstation setup.

Use this preference order:

1. Existing compatible installation (verify version and source).
2. Official OS-native package/repository supported for this exact OS and architecture.
3. Official vendor binary or installer for this exact OS/architecture, with checksum/signature verification when published.
4. Official version-manager prebuilt release compatible with the host.
5. Source build only when the vendor documents the host/toolchain as supported, dependencies are available, resource requirements are acceptable, and owner approval is obtained for lengthy/system-level changes.
6. If no supported route exists, stop that tool's installation, report `UNSUPPORTED ON THIS HOST`, keep other safe work moving, and explain the options. Do not lower OpenLevel's runtime requirement or install an EOL/insecure version silently.

Do not make Homebrew a prerequisite. It is an optional macOS package manager and may be Tier 3 on older macOS/Intel configurations. Use MacPorts, vendor installers, official portable binaries, or supported Linux native package managers as appropriate. Do not force Homebrew formula builds from source on old systems.

### Compatibility policy for versions

#### Node.js

- OpenLevel requires Node `>=22.0.0`; GitHub Actions currently uses Node 22. Keep both unchanged.
- Install the latest patch release of Node 22 that is compatible with the host. Project-local Node selection remains major 22.
- The latest Active LTS major may be installed alongside Node 22 only when the host supports its published binary/toolchain floor; it is optional and must not override the repository's Node 22 selection.
- Current Node release status (2026-11-16): Node 26 Active LTS; Node 24 and 22 Maintenance LTS. Do not install odd-numbered Current/Alpha or EOL releases as a default.
- Crucial: Node 22's versioned support matrix allows macOS 11.0+ on x64 and arm64, so Node 22 works at the OS support level on Monterey 12. Node 24/26 binaries have a newer macOS minimum (13.5); skip those on Monterey unless the exact selected artifact is proven compatible.
- For Linux, verify the exact Node major/patch and glibc/musl/architecture requirement. Node 22's official Tier 1 Linux builds list x64/arm64 and glibc >=2.28. Use a compatible distro package or official asset when appropriate.
- Prefer an existing Node manager; otherwise use a cross-platform manager such as fnm. Use `.nvmrc` with `22` (or equivalent manager-native pin). Ensure fresh terminals select Node 22 inside the repository.
- Neon npm CLI needs Node >=20.19; the repository's Node 22 satisfies this.
- Do not install Node 20 or below to make this project start. If no supported Node 22 runtime can execute on a host, mark `task dev` blocked on that host and give the owner a compatible-host/OS-upgrade option.

#### PostgreSQL

- Install the newest stable major/patch supported by the host OS and architecture.
- As of 2026-11-16, PostgreSQL 18.7 is the newest stable major line; do not install PostgreSQL 19 RC2 as a stable dev database.
- On macOS Monterey 12, use the newest supported PostgreSQL 17 patch where current EDB compatibility matrix supports that architecture (PG17 tested on macOS 11.x Intel and 12.x Apple Silicon). Do not force PG18, whose EDB macOS installers are tested on macOS 13+.
- On newer macOS 13+, PG18 may be installed where official package support exists.
- On Linux, use PGDG for currently supported distribution releases/architectures. For old distros not in PGDG's supported list, use the distro-supported maintained package only when acceptable; otherwise report the blocker and ask before adding repos/building from source.
- Keep CI PostgreSQL 16.16 unchanged. Document the local server major actually installed.

#### Task CLI

- Install latest stable Task CLI release for the exact OS/architecture.
- Prefer the official binary installer (which verifies its release checksum) into `~/.local/bin` when a package manager is unavailable or unsupported.
- Official package managers may be used when compatible: Homebrew/MacPorts on macOS; apt/dnf/apk/pacman on supported Linux; use the exact package repository docs.
- Taskfile schema must use the minimum CLI/schema feature level needed, not speculative newest-only features.

#### Fly CLI

- Install latest stable `flyctl`/`fly` release compatible with the host using official Fly installer or official release assets.
- Support macOS and Linux; avoid mandatory Homebrew.
- Verify `fly version` and `fly help`.
- Do not run auth/login, app creation, launch, deploy, scale, machine operations, secret operations, or migration commands.

#### Neon CLI

- Install latest stable `neon` CLI compatible with host.
- Preferred: `npm install --global neon@latest` under the repository-compatible Node 22 runtime (the package requires Node >=20.19).
- Alternative: use the official standalone release binary only if the exact OS/architecture asset exists and integrity can be checked.
- Verify `neon --version` and `neon --help`.
- Do not authenticate, initialize, link, checkout remote context, pull environment files, create/delete branches, apply migrations, or mutate any remote Neon resource.

### 0. Preflight: confirm Muse and repository access

The owner previously encountered macOS Monterey TCC denial when Muse/Git tried to read the repository under `Documents`.

Before changes:

- Print `pwd -P`, `$HOME`, `whoami`, and `git rev-parse --show-toplevel` from the actual workspace; do not assume account name equals the home-directory basename.
- If the Documents path is denied, stop and ask the owner to move/copy the complete checkout to `$HOME/work/openlevel` or grant the narrow Documents-folder permission to the actual terminal/launcher. Prefer relocation over Full Disk Access.
- Never change home-directory ownership/name, use `muse init --force`, reinitialize Muse, or destroy/recreate its session to bypass the permission error.
- Do not continue against an archive or stale copy without owner confirmation.

### 1. Live repository reconnaissance

Inspect the actual working tree, not prior plan snapshots:

- Git root, branch, HEAD, remotes, status, staged/unstaged/untracked files.
- Preserve all user changes and planning documents. Do not clean, reset, checkout, rebase, merge, or commit.
- Canonical GitHub repository default branch is `master`; PR #2 was merged in `708458d2e80cae4d831bc0fee5772790488a33f9`, but local HEAD may differ. Treat live local state as authoritative for this task.
- Inspect `package.json`, package scripts, lockfile, `.github/workflows/phase0.yml`, `server/dev-server.ts`, `server/index.ts`, `vite.config.ts`, `.env.example`, `db/schema.sql`, `db/migrate.ts`, `db/seed.ts`, all Fly configs and Neon architecture docs.
- Check for existing `Taskfile.yml`, `AGENTS.md`, `.nvmrc`, `.node-version`, `mise.toml`, `docs/development/`, tool version managers, package managers, shell RC files, and installed CLIs.
- Never print or inspect the content of `.env`, credential files, or secret stores. It is permissible to check whether a file exists without reading it.
- Re-verify all package scripts before wrapping them. Do not expose a task for a nonexistent script (for example, `scripts/shoot.mjs` must not be assumed to exist just because a package script refers to it).

### 2. Detect OS, architecture, and ABI

Create a reliable, non-secret host report used by `task doctor` and the installer.

macOS detection:

- `sw_vers -productVersion`, `uname -m`, hardware model (`sysctl`), kernel, available Xcode Command Line Tools (`xcode-select -p`, `clang --version`), Rosetta state if relevant, Homebrew/MacPorts presence and health.
- Distinguish Intel x86_64 from Apple Silicon arm64.
- Detect the actual deployment target required by a binary/package; do not treat a package manager's mere presence as compatibility evidence.

Linux detection:

- `/etc/os-release` (ID, VERSION_ID, VERSION_CODENAME), `uname -m`, kernel, libc family/version (`getconf GNU_LIBC_VERSION`, `ldd --version`, or musl detection), package manager (apt/dpkg, dnf/rpm, yum, zypper, apk, pacman, etc.).
- Distinguish glibc from musl and detect architecture exactly.
- Do not assume Ubuntu/Debian just because apt exists; inspect the actual distro.

Supported target families for this project are macOS and Linux. Support `darwin/amd64`, `darwin/arm64`, `linux/amd64`, and `linux/arm64` whenever official compatible releases exist. Support other Linux architectures only when the specific required tools publish compatible assets and the OpenLevel dependencies are known to work. Fail clearly on unsupported OS/architecture.

Write the detected facts to a safe diagnostic report. Do not expose usernames, secrets, environment values, full connection strings, or unrelated personal data.

### 3. Adaptive toolchain installation

Implement a compatibility-aware installer or a carefully documented installation procedure. It must be idempotent and must not assume Homebrew.

Add a machine-readable or structured compatibility report with fields such as:

- tool name and purpose
- selected version and stable/LTS status
- OS/architecture/libc target
- official source URL
- installation method
- compatibility evidence (minimum OS, libc, architecture)
- checksum/signature result where published
- actual `--version` result
- status: `INSTALLED`, `ALREADY_COMPATIBLE`, `SKIPPED_OPTIONAL`, `UNSUPPORTED`, or `BLOCKED_OWNER_ACTION`

For tools that require system package manager access or administrator privileges, show the precise install command and pause for owner approval/input. Do not request or receive the sudo password in chat or write it to files. Prefer user-local installation for standalone CLIs.

Do not write tool binaries into the repository tree unless there is a clear project-local reason. Prefer `~/.local/bin` or manager-owned paths; ensure PATH additions are idempotent and backed up before shell RC changes. On macOS zsh and Linux bash/zsh, configure the appropriate startup file without overwriting content. If the current shell is not supported, print manual activation steps.

Homebrew is optional. If present, check `brew config`/`brew doctor` and whether the host is a supported tier. Do not depend on it on Monterey or Intel macOS. MacPorts is an option only when the exact port supports the detected OS/architecture. Use official per-user binaries where possible.

### 4. Taskfile portability design

Create root `Taskfile.yml` as the single agent/developer command interface.

- Use Task's `platforms` selection for `darwin` and `linux`; share common commands/tasks.
- The Taskfile must not rely on Bash-only syntax or GNU-only flags.
- Avoid shell constructs that differ between macOS BSD userland and GNU/Linux (`sed -i`, `readlink -f`, GNU `date`, unportable `timeout`, etc.).
- Use Node helper scripts for host detection, database service controls, environment validation, and process orchestration when logic is nontrivial.
- Use portable POSIX shell only for short trivial commands.
- Use root-relative file paths and task descriptions.
- Use vars/env and Task secret-masking appropriately; never echo credentials.
- `task --list` must be meaningful, namespace-organized, and usable by agents.
- `task doctor` must be safe/read-only and identify missing or incompatible tools with specific fixes.
- A missing optional CLI must not prevent `task dev` or unit tests. Distinguish required from optional tools.

Required command catalog (adjust only to actual repo capabilities):

```text
help
doctor
tools:detect
tools:plan
tools:install
tools:versions
tools:upgrade
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
test:phase0:unit
test:phase0:integration
typecheck
build
check

fly:version
fly:help
fly:apps
fly:status
fly:logs
fly:releases
fly:open
fly:deploy

neon:version
neon:help
neon:projects
neon:branches
neon:diff
neon:inspect
```

No task may wrap a nonexistent script or assume a config file that does not exist. No task may default to the isolated P2 staging Fly configuration.

`tools:plan` prints the proposed compatible tool versions/install methods without modifying the host. `tools:install` requires explicit confirmation (e.g. `CONFIRM_TOOL_INSTALL=yes`), runs only the plan's approved local operations, and pauses for owner action when administrator privileges or macOS permission changes are needed. `tools:upgrade` should preview first and require confirmation to apply. Avoid automatic major-version changes to OpenLevel's Node runtime.

### 5. One-command local dev startup

Highest priority:

```sh
task dev
```

Use Taskfile as the public command interface and a small `scripts/dev.mjs` Node built-in launcher for lifecycle management.

Known current app topology (reconfirm from source):

- Backend: existing `server/dev-server.ts` launched by `npm run dev:local`, using in-memory PGlite, schema initialization, seeded demo data, and offline provider stubs; API port 8790.
- Frontend: Vite launched by `npm run dev` on port 5273, with `/api` proxy to the backend.
- Backend health route: `GET /health`.
- Demo login: `admin@acmecorp.com` / `openlevel`.

Required behavior:

1. Check the repository-selected Node 22 runtime and installed dependencies.
2. Detect port conflicts on 8790 and 5273 before spawning. Fail with the process/port details and remediation; never silently choose other ports.
3. Start the backend with explicit hostname `127.0.0.1`; start Vite with `--host 127.0.0.1 --port 5273` and strict port behavior.
4. Wait for backend `/health` and frontend readiness with bounded timeouts and useful diagnostics.
5. Print UI URL, API URL, health URL, demo login, and a note that PGlite is in-memory and resets on restart.
6. Open the browser by default (`open` on macOS; `xdg-open` or verified fallback on Linux). Support a no-browser environment flag for CI/automation.
7. Forward both processes' stdout/stderr with clear prefixes.
8. Handle SIGINT/SIGTERM; terminate the entire child process groups, wait gracefully, escalate after a fixed bounded timeout, and confirm both children exit. Do not leave orphan `vite`, `tsx`, or `node` processes.
9. If either child exits unexpectedly or readiness times out, terminate the other child and return nonzero.
10. Do not use real Anthropic, Chatwoot, Twilio, Stripe, Neon, or other external integrations for the offline demo.
11. Keep any required source change dev-only. If the API is not loopback-only, make the smallest change to `server/dev-server.ts` using the documented `@hono/node-server` hostname option. Do not modify production server binding or CI.
12. `task dev:api`, `task dev:web`, `task dev:health`, and `task dev:open` must be useful individually and documented.

Example startup banner:

```text
OpenLevel local development
API      http://127.0.0.1:8790
UI       http://127.0.0.1:5273
Health   http://127.0.0.1:8790/health

Demo login
Email    admin@acmecorp.com
Password openlevel

PGlite is in-memory; demo data resets when the API restarts.
Press Ctrl+C to stop both processes.
```

### 6. Local PostgreSQL tasks

PGlite for `task dev` stays separate from the native PostgreSQL server. `task dev` must work without PostgreSQL server installation or service start.

Expose local PostgreSQL management tasks using a cross-platform helper or platform-specific Task commands:

- macOS: detect the installed provider (EDB app/installer, Postgres.app, MacPorts, Homebrew only if functioning); do not assume `brew services` exists.
- Linux: detect systemd, OpenRC, or the actual service manager; respect distro package naming and versioned cluster conventions.
- If an action needs sudo/admin, ask the owner to run or approve the exact command. Do not use sudo with password piping.

Use local DB convention from `.env.example` only after verifying live content without printing `.env`: database `openlevel`, local role `openlevel`, loopback port 5432. Do not overwrite existing roles/databases/clusters.

`db:migrate`, `db:seed`, and `db:psql` must parse `DATABASE_URL` and require a loopback hostname plus the exact local DB name. Do not rely on substring checks. If safe local DB configuration is absent, fail and explain how to configure it without exposing credentials.

Do not create destructive `db:reset` as a normal task. No database drop/restore/overwrite operations.

### 7. Test and quality tasks

Wrap existing verified package scripts and CI checks only:

- root typecheck
- Phase 0 typecheck (`npx tsc -p phase0/tsconfig.json --noEmit` if still the actual CI command)
- full test suite
- Phase 0 unit suite
- Phase 0 integration suite
- build
- `check` aggregate

Do not weaken tests or replace real PostgreSQL/concurrency proof with mocks.

Local-first workflow:
1. focused tests for changed code
2. unit tests
3. root + Phase 0 typechecks
4. local PostgreSQL integration/race tests when supported
5. build
6. GitHub Actions confirms the committed code in CI

Report `PASS`, `FAIL`, or `NOT RUN`. Docker/Testcontainers-backed suites remain `NOT RUN` locally when Docker is unavailable; do not claim they passed. Do not install Docker for this task.

### 8. Fly task interface and deployment guard

Read existing Fly architecture docs and configurations.

Important: `phase0/p2/fly.staging.toml` is an isolated P2 proof app, not the complete OpenLevel product config. There is no root product `fly.toml` unless live reconnaissance proves otherwise.

Expose read-only commands with explicit `FLY_APP` where needed. No implicit app from the current directory.

`fly:deploy` may be defined for future use only and must refuse:
- missing `FLY_APP`
- missing `FLY_CONFIG`
- nonexistent config path
- `phase0/p2/fly.staging.toml`
- config declaring the P2 staging app
- missing `CONFIRM_DEPLOY=yes`

Even with all variables, do not execute the deploy task. Do not create a product Fly config, run `fly launch`, authenticate, deploy, scale, stop/start machines, alter secrets, or run migrations.

### 9. Neon task interface

Expose current `neon` CLI help/version and read-only task definitions only. Confirm exact syntax against the installed `neon --help` and current official docs. Require explicit project ID for project/branch tasks. Do not embed project IDs, auth tokens, database URLs, or credentials.

Do not run authentication or any remote mutation. If a read command requires authentication and the CLI is not already authenticated, report `SKIPPED — owner authentication required`; do not start login.

### 10. Documentation and agent discoverability

Create or minimally update:

- root `AGENTS.md` (preserve existing instructions if present)
- `docs/development/LOCAL_DEVELOPMENT.md`
- `docs/development/TOOLCHAIN_COMPATIBILITY.md`

The compatibility document must record the tested tool versions, host OS/architecture/libc, official compatibility source, install method, and why a version was chosen or skipped. It must explain how another macOS/Linux agent resolves the latest compatible version on its own host. Do not hardcode today's version numbers as permanent future truth.

Root `AGENTS.md` must instruct coding agents:
1. Start with `task --list`.
2. Run `task doctor` before substantial work.
3. Use `task dev` to view the UI.
4. Use Taskfile commands instead of memorizing bespoke shell commands.
5. Follow Local-First, CI-Confirmed verification.
6. Report PASS/FAIL/NOT RUN truthfully.
7. Never print or inspect `.env` or secrets.
8. Never use live Neon/Fly resources for local tests.
9. Do not deploy or mutate remote DB/cloud resources without separate explicit owner authorization.
10. Preserve Git changes; no commits/pushes unless specifically requested.

Docs must show platform differences without making the developer memorize them. Include the demo login and the PGlite reset behavior.

### 11. Verification and cross-platform evidence

#### Host detection and toolchain

Capture and verify (when available):

```sh
uname -a
# macOS: sw_vers -productVersion; Linux: cat /etc/os-release
node --version
npm --version
psql --version
pg_isready
task --version
fly version
neon --version
```

Also record architecture, libc family/version on Linux, and installed Node manager. Do not print any credentials or `.env` contents.

#### Taskfile validation

Run:

```sh
task --list
task doctor
task --dry dev
task --dry typecheck
task --dry test:phase0:unit
task --dry fly:deploy
```

The guarded deploy dry-run must show safety preconditions and must not execute a deploy. Inspect command expansion for secrets, unguarded cloud operations, wrong paths, shell-specific syntax, or P2-as-product defaults.

#### Local UI proof

Run `task dev` and verify:
- backend binds only to loopback and `/health` succeeds
- Vite binds only to loopback and responds
- browser opens correct URL
- `/login` page visibly renders
- demo login succeeds and redirects to `/assistant`
- at least one real UI-triggered API request succeeds
- Ctrl+C terminates both process trees without orphans

Use available browser automation or visible owner-assisted validation. An HTTP response alone is not proof of rendered UI/login.

#### Database proof

Verify local PostgreSQL service status/start/stop, local version, and (if a safe isolated local DB is provisioned) migrate/seed behavior. Do not destroy existing databases. Ensure PGlite `task dev` works regardless of native PostgreSQL service state.

#### Tests and build

Run applicable unit tests, typechecks, builds, and local DB checks. Report unavailable Docker/Testcontainers or platform-specific checks as `NOT RUN`.

#### Portability evidence

- Execute on the actual macOS host.
- Validate Taskfile's Linux command selection and helper behavior with tests or an available Linux environment.
- Do not claim Linux runtime verification if no Linux host/runner was available.
- Do not modify `.github/workflows/phase0.yml` or add CI jobs; CI pins and workflows remain untouched.
- The Taskfile must include an explicit unsupported-platform guard and must not accidentally invoke macOS-only commands on Linux or vice versa.

### 12. Scope, safety, and final report

May modify/add only the files needed for:
- root `Taskfile.yml`
- a minimal Node launcher and narrowly scoped helpers (e.g. `scripts/dev.mjs`, `scripts/toolchain.mjs`, `scripts/db-service.mjs`)
- repository Node 22 version file
- `AGENTS.md`
- `docs/development/LOCAL_DEVELOPMENT.md`
- `docs/development/TOOLCHAIN_COMPATIBILITY.md`
- minimal dev-only loopback binding change if proven necessary

Do not:
- modify package.json engines or dependency versions solely to accommodate an old host
- modify GitHub Actions CI pins/workflows
- change production app architecture or DBOS/Fly/Neon configuration
- inspect, print, add, or commit secrets
- authenticate to Fly or Neon
- create or modify cloud resources
- deploy, migrate remote databases, scale/stop machines, or change remote secrets
- install Docker
- run destructive local database operations
- commit, push, merge, tag, or alter Git history

At the end, provide:
1. Independent adversarial verdict.
2. Exact files changed and concise diff summary.
3. Host facts: OS/version, architecture, package manager, libc if Linux.
4. Tool compatibility matrix: requested newest stable, selected compatible version, skipped versions and reasons, official source, installation method, verification output.
5. `task --list` catalog.
6. `task doctor` results.
7. `task dev` evidence for browser, login, UI-to-API, and clean shutdown.
8. Local DB checks.
9. Tests/build/typechecks with exact commands and PASS/FAIL/NOT RUN.
10. Linux portability validation and limitations.
11. Manual owner actions still required.
12. Git status and diff inventory proving nothing committed or pushed.

Stop after implementation, local verification, cross-platform adversarial review, and report. Do not wait for future work or claim work will happen later.

## Definition of Done

The same committed Taskfile is usable on supported macOS and Linux hosts. Each host independently selects the latest stable dependency versions compatible with its OS/architecture/ABI while preserving OpenLevel's Node 22 project contract and existing CI versions.

The developer can discover commands with `task --list`, diagnose the workstation with `task doctor`, and launch the real local UI with one command:

```sh
task dev
```

**Guiding principle: One Taskfile across Mac and Linux. Latest compatible tools per host. One command to start the app. Local-first verification. Owner-controlled cloud operations.**

---

# Part III — Current compatibility reference snapshot (do not treat as permanent pins)

This section records the official facts checked on 2026-11-16. Muse must re-check the live official sources before installing anything.

| Component | Current release/support fact | Implication |
|---|---|---|
| Node.js | 26 Active LTS; 24 and 22 Maintenance LTS | OpenLevel stays on Node 22 due package engine/CI. Install newer LTS only where the host supports it. |
| Node.js 22 on macOS | v22.x supports macOS 11+ x64/arm64 | Monterey 12 can use Node 22. |
| Node.js 24/26 on macOS | current binary floor 13.5+ | Skip on Monterey; do not use as project runtime. |
| PostgreSQL | 18.7 newest stable major; 19 RC2 is not stable | Use PG18 where host supports it; use latest maintained compatible major on older hosts. |
| PostgreSQL macOS installers | EDB PG18 tested on macOS 13+; PG17 tested on Monterey-compatible versions | Monterey uses current stable PG17 patch; newer macOS may use PG18. |
| Homebrew | Monterey/older macOS and Intel are Tier 3 per current support policy | Optional only; never make it the only installer route. |
| Task | Official installer downloads release binary and verifies checksum | Suitable per-user fallback without Homebrew. |
| Fly CLI | Official macOS/Linux install script and release binaries | Can be installed without Homebrew; no auth/deploy. |
| Neon CLI | npm `neon` requires Node >=20.19; platform binaries are also published | Node22 npm route works; use a verified matching binary when appropriate. |

Official references:
- Node releases: https://nodejs.org/en/about/previous-releases
- Node 22 build/platform matrix: https://github.com/nodejs/node/blob/v22.x/BUILDING.md
- Current Node build matrix: https://github.com/nodejs/node/blob/main/BUILDING.md
- Homebrew support tiers: https://docs.brew.sh/Support-Tiers
- PostgreSQL macOS: https://www.postgresql.org/download/macosx/
- PostgreSQL Linux: https://www.postgresql.org/download/linux/
- Task installation: https://taskfile.dev/docs/installation
- Task platform selection: https://taskfile.dev/docs/guide/platforms
- Fly CLI installation: https://fly.io/docs/flyctl/installing
- Neon CLI: https://neon.com/docs/cli and https://www.npmjs.com/package/neon
