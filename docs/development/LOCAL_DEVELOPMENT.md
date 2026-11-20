# OpenLevel local development

One Taskfile across Mac and Linux. One command to start the app.
Local-first verification. Owner-controlled cloud operations.

## First run

```sh
task --list     # discover every command
task doctor     # diagnose the workstation; fix FAIL items first
task deps:install   # reproducible install (npm ci, same as CI)
task dev        # start API + UI, open the browser
```

`task dev` starts the real React/Vite UI (`http://127.0.0.1:5273`) and the
local Hono API (`http://127.0.0.1:8790`, health at `/health`), waits for both,
prints the demo login, forwards prefixed `[api]`/`[web]` logs, and stops both
process trees on Ctrl+C. Both processes are loopback-only. Set `NO_BROWSER=1`
to skip the browser open in automation. Override the bind per run when needed,
e.g. `task dev WEB_PORT=5280` or `task dev API_PORT=8899` (`dev:api`/`dev:web`/
`dev:health`/`dev:open` honor the same contract). The API listener, Vite
listener, Vite `/api` proxy target (`http://127.0.0.1:<api-port>` by default),
health probes, and printed URLs all derive from one validated resolution;
invalid ports are rejected before anything starts. The host stays
loopback-only: `127.0.0.1` (default), `::1`, or `localhost` (normalized to
`127.0.0.1`); anything else (`0.0.0.0`, external IPs, DNS names) is refused in
the launcher and in each server, so direct `dev:api`/`dev:web` invocation
cannot bypass it.

Demo login: Email `admin@acmecorp.com`, password `openlevel`.
The dev database is in-memory PGlite: demo data resets when the API restarts.

## Task catalog (namespaces)

Run `task --list` for the authoritative list with descriptions.

- `help`, `doctor`, `platform:check` — discover, diagnose, OS gate.
- `tools:detect|plan|install|upgrade|versions` — host facts, compatible-version
  plan, guided installs (confirmation-gated), version report.
- `deps:install|audit` — reproducible install, vulnerability audit.
- `dev`, `dev:api|web|health|open` — full session or single pieces.
- `db:version|status|start|stop|create|migrate|seed|psql` — native local
  PostgreSQL only; every mutating task passes the loopback + local-db guard.
- `test`, `test:unit`, `test:phase0`, `test:phase0:unit`,
  `test:phase0:integration`, `typecheck`, `typecheck:phase0`,
  `typecheck:scripts`, `build`, `check`.
- `fly:version|help|apps|status|logs|releases|open` (read-only) and the
  future-only guarded `fly:deploy` (never run without owner authorization).
- `neon:version|help|projects|branches|diff|inspect` (read-only; reports
  SKIPPED when owner authentication is missing instead of logging in).

## Local PostgreSQL (native server, separate from PGlite)

`task dev` needs no PostgreSQL installation — it uses in-memory PGlite. The
native server is for migration/seed checks and DB-backed tests.

```sh
export DATABASE_URL=postgres://openlevel:openlevel@127.0.0.1:5432/openlevel
task db:status
task db:create    # create role + db when missing; never overwrites
task db:migrate
task db:seed
```

The guard parses `DATABASE_URL` and accepts only a loopback host
(`localhost`, `127.0.0.1`, `::1`) plus the exact local database `openlevel`.
Anything else — Neon, Fly, remote IPs, DNS names, other db names, malformed
URLs — is refused before anything runs. Connection strings and passwords are
never printed. There is deliberately no `db:reset` task.
Provider-detection details are available directly via
`node scripts/db-service.mjs detect`.

PostgreSQL major-upgrade policy: installing a newer binary never
auto-upgrades a data cluster. A major move requires a verified backup, a
compatibility assessment, and a separate owner-approved migration. `db:start`
refuses to start when it can prove the binary major differs from the data
directory major.

## Test workflow

Local-first, CI-confirmed:

1. Focused tests for changed code.
2. `task test` (unit suite).
3. `task typecheck` and `task typecheck:phase0` (both are CI gates).
4. `task test:phase0:integration` where Docker/Testcontainers runs; otherwise
   report NOT RUN honestly — never claim it passed.
5. `task build`.
6. `task check` runs 2 + 3 + 5 in order. GitHub Actions confirms commits.

## Fly and Neon from the Taskfile

Read-only commands take explicit names (`FLY_APP=...`, `PROJECT_ID=...`);
nothing is inferred from the directory, and nothing defaults to the isolated
P2 staging config (`phase0/p2/fly.staging.toml` is the Phase 0 proof app, not
the product). `fly:deploy` refuses missing/invalid inputs and the P2 config,
requires `CONFIRM_DEPLOY=yes`, and is for future use — any real deploy, scale,
machine, secret, or remote-migration operation needs separate explicit owner
authorization. Neon read commands that hit missing auth report
`SKIPPED — owner authentication required` and never start a login.

## Local vs remote boundaries

Local (safe, no approval): `dev`, `test`, `typecheck`, `build`, `check`,
`db:*` against the guarded loopback database, `tools:*` previews and safe
per-user installs, `fly:*`/`neon:*` read-only views.
Owner-gated (explicit approval + often the owner at the keyboard): anything
needing sudo/admin (package installs, service control, macOS .pkg
installers), PostgreSQL major migrations, `fly:deploy`, and any Neon/Fly
mutation or authentication.

## Troubleshooting

- `task dev` refuses with "port already in use": another process holds 8790
  or 5273. The message names it (`lsof`/`ss`); stop that process and retry.
  The launcher never silently picks another port. Other bind failures say
  exactly what happened: "cannot bind (EPERM...)" means the environment
  forbids listening (e.g. sandboxed sessions); "cannot bind
  (EADDRNOTAVAIL...)" means the address is absent on the host; anything else
  reports its error code. Only "already in use" means another process holds
  the port.
- `DATABASE_URL is not set` / guard refusal: export the local URL (see
  above); check `.env.example` for the convention. Never export a Neon or
  production URL for these tasks — the guard will refuse it.
- `node ... is below the repository runtime`: select Node 26 in your version
  manager (`.nvmrc` pins it); `task doctor` shows what is active.
- `task` / `fly` / `neon` / `psql` not found: `task tools:plan` prints the
  compatible route for your exact host; `task tools:install
  CONFIRM_TOOL_INSTALL=yes` applies the safe per-user steps and prints exact
  owner commands for the rest.
- Intel Mac / older macOS (Homebrew Tier 3): Homebrew is optional, never
  required. Use the EDB/Postgres.app/MacPorts or official-binary routes from
  `task tools:plan`; never force formula builds from source.
- Linux without `xdg-open`: `task dev` prints the URL when no opener works;
  install `xdg-open` (xdg-utils) for one-command browser behavior.
- Linux service control: `db:start|stop` print the exact `sudo` command for
  your init system instead of running it.
- macOS TCC denies the repo under Documents: move the complete checkout
  (`.git`, ignored/untracked files, all changes) to `$HOME/work/openlevel`
  or grant the terminal narrow Documents access. Never rename/chown home
  directories or grant Full Disk Access as the first resort.
