# OpenLevel toolchain compatibility

How each macOS/Linux host independently selects tool versions, and what was
selected on the hosts set up so far. Companion to the executable logic in
`scripts/toolchain.mjs` (`tools:detect`, `tools:plan`, `tools:install`,
`task doctor`).

## Policy (non-negotiable)

- Install the newest STABLE version compatible with the detected host — OS
  family + release, CPU arch, ABI/libc, and the vendor's published support
  matrix. Never EOL, beta, RC, development, or odd-numbered Current builds
  as defaults.
- OpenLevel's runtime contract is fixed: `package.json` engines `node
  >=26.0.0`, CI pins Node 26, Phase 0 proof PostgreSQL stays digest-pinned
  16.16 while the product image job uses the current stable PG (18.7). No
  host workaround may change engines, CI pins, or application dependencies
  (`npm ci` only; no `npm update`, no lockfile regeneration for workstation
  setup).
- Homebrew is optional, never mandatory. Older macOS and Intel Macs sit
  outside Homebrew's fully supported tier: prefer supported native packages
  or official per-user binaries there; never force source builds.
- PostgreSQL major-upgrade safeguard: installing a newer binary must NEVER
  auto-migrate or replace a data cluster. A major move requires a verified
  backup, a compatibility assessment, and a separate owner-approved
  migration procedure. No Taskfile task performs upgrades or destructive
  database operations.
- No tool install may authenticate to Fly/Neon, create cloud resources, or
  deploy. Admin-gated steps print the exact owner command and wait.

Status vocabulary used by `tools:install` and reports: `INSTALLED`,
`ALREADY_COMPATIBLE`, `SKIPPED_OPTIONAL`, `UNSUPPORTED`, `BLOCKED_OWNER_ACTION`
(owner must run/approve something outside the agent session).

## Resolution procedure (any host)

1. `task tools:detect` — record OS/version, arch, libc (Linux), distro +
   codename (Linux), CLT (macOS), package managers, Node managers.
2. `task tools:plan` — prints the per-tool route for THIS host with the
   official source for each decision. Re-check the live sources; the
   snapshot date below is not truth.
3. `task tools:install CONFIRM_TOOL_INSTALL=yes` — applies safe per-user
   steps; prints exact commands and pauses for everything admin-gated.
4. `task doctor` — confirms required tools; INFO/WARN rows are optional.

Per-tool rules:

- Node 26 (REQUIRED): latest 26.x patch compatible with the host, via the
  existing manager else a cross-platform one (e.g. fnm). Node 26 Active LTS
  binaries need macOS 13.5+; Linux Tier 1 needs glibc >=2.28.
  `.nvmrc` pins 26; fresh shells must resolve 26 in this repo. If no
  supported Node 26 runs on a host: BLOCKED, upgrade the host — never lower
  the requirement.
- Node newer Current (OPTIONAL): install alongside 26 only for evaluation
  where the published binary floor allows. Never the repo runtime.
- PostgreSQL (see safeguard above): newest stable major+patch with official
  support for the exact OS/arch. macOS: EDB installer line whose matrix
  covers the host (PG17 line on Monterey 12, PG18 where 13+); alternatives
  Postgres.app / MacPorts / brew-if-healthy. Linux: official PGDG repo when
  the codename is listed, else evaluate the distro-maintained package.
- Task CLI: supported system package, else the official installer into
  `~/.local/bin` (inspect the script; release checksum verified).
- Fly CLI (`fly`): official installer or release asset into `~/.local/bin`
  (inspect; verify checksum/signature when published). Never auth/deploy.
- Neon CLI (`neon`): `npm install --global neon@latest` under Node 26 (needs
  Node >=20.19), else the exact OS/arch standalone binary with integrity
  check. Never auth/init/link/env-pull.

Official sources (re-check live before installing):
Node releases, Node v26.x + main BUILDING.md, Homebrew support tiers,
PostgreSQL macOS/Linux download matrices, Task installation + platforms
guides, Fly flyctl installation, Neon CLI docs + npm package page.
`task tools:plan` prints the exact URLs.

## Runtime-contract change (2026-11-19)

The repo runtime moved from Node 22 to Node 26 Active LTS (engines
`>=26.0.0`, `.nvmrc` 26, CI 26, both Dockerfiles `node:26-slim`) after the
full gate passed under v26.13.1: app suite 1665 passed + the 1 pinned
baseline vault failure, `test:phase0:unit` 287/287, both typechecks, and
`vite build`. The MacBookAir7,1 record below is therefore historical:
Monterey 12 cannot run Node 26 binaries (macOS 13.5+ floor), so that host
is BLOCKED until upgraded — per policy the requirement is never lowered.
Phase 0 proof PostgreSQL stays digest-pinned 16.16 (P2 container-identity
evidence); only the product image job targets the current stable PG 18.7.

## Host record — Linux workstation (2026-11-19)

Detected: Linux x64, glibc 2.39, nvm with Node v24.13.1 active, psql 16.14
client with no local server cluster, Docker with `postgres:18.6-alpine`
cached, flyctl + neon CLIs present (no auth).

Selected: Node v26.13.1 "Lithium" (Active LTS since 2026-10-28) via the
existing nvm manager; `npm ci` reinstalled under 26; no local PostgreSQL
server installed (PGlite covers app dev, ephemeral containers cover
PG-backed verification); `postgres:18.7` + `node:26-slim` pulled for the
product image and migration validation. Owner action to finish the
workstation switch: `nvm use 26` (or `nvm alias default 26`) inside the
checkout; `task doctor` then reports the runtime OK instead of WARN/FAIL.

## Host record — MacBookAir7,1 (2026-11-16, historical)

Detected: macOS 12.7.6 Monterey, Intel x86_64, CLT installed, bash with
`~/.local/bin` on PATH. No brew, MacPorts, Node manager, node, psql, task,
fly, or neon present. Repo reads fine from this session (no TCC block).

Selected routes (snapshot 2026-11-16 — re-verify live sources at install):

| Tool | Verdict | Route |
|---|---|---|
| Node 22 | BLOCKED_OWNER_ACTION | Latest 22.x patch via fnm (official darwin-x64 asset, macOS 11+ floor OK); `.nvmrc` already pins 22 |
| Node latest LTS | SKIPPED_OPTIONAL | Binaries need macOS 13.5+; this host stays on Node 22 only |
| PostgreSQL | BLOCKED_OWNER_ACTION | Newest stable PG17 patch via EDB macOS installer (PG18 targets 13+); admin-gated .pkg, owner runs it |
| Task CLI | BLOCKED_OWNER_ACTION | Official installer into `~/.local/bin` (inspect script first); no supported brew here |
| Fly CLI | BLOCKED_OWNER_ACTION | Official installer/asset into `~/.local/bin` (inspect first); no auth |
| Neon CLI | BLOCKED_OWNER_ACTION | After Node 22: `npm install --global neon@latest`; no auth |

Exact owner sequence on this host (after re-checking the sources above):

```sh
# 1. Node manager + Node 22 (inspect the installer first)
curl -fsSL https://fnm.vercel.app/install | sh   # REVIEW before running; or a supported native package
fnm install 22 && fnm default 22
node --version  # expect v22.x (run inside the repo checkout)

# 2. Task + Fly CLIs into ~/.local/bin (inspect each installer first)
sh -c "$(curl -sSL https://taskfile.dev/install.sh)" -- -b ~/.local/bin   # REVIEW before running
curl -L https://fly.io/install.sh | sh                                    # REVIEW before running

# 3. PostgreSQL 17: download the EDB macOS installer for the PG17 line,
#    verify its checksum, run the .pkg (admin password), start the server.
#    Never let an installer migrate an existing cluster automatically.

# 4. Neon CLI under Node 22
npm install --global neon@latest

# 5. Verify through the Taskfile itself
task --list && task doctor && task deps:install && task dev
```

Session record (2026-11-16): network egress worked through the sandbox
proxy (slow — allow >15s per fetch), so a session-scoped bootstrap ran the
full pass: official Node v22.23.5 + Task 3.54.0 darwin-x64 binaries,
checksum-verified, into `/tmp` (the sandbox denies `~/.local/bin` writes,
so the persistent workstation install above remains an owner action).
Results: `list/doctor/detect/versions/plan/gate`, both typechecks,
`test:phase0:unit` (284), and `build` PASS; all guards fail closed as
designed (missing vars, P2 config, remote/non-local DB URLs refused);
`test` shows 1589 passed + the 1 pinned baseline vault failure;
integration suites fail fast without Docker. NOT RUN: live `task dev`
(and `dev:api`/`dev:web`) — the sandbox forbids `listen()` sockets, so the
launcher's fail-closed EPERM path was verified instead of the running
servers — plus real browser proof and the PG-backed migrate/seed chain
(no server). Per-command log: rerun the pass after step 5 above; Task
surfaces any failing task as exit 201 with the inner exit code in its
`Failed to run task` message.