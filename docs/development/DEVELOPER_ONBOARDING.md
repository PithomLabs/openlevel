# OpenLevel developer onboarding

From clone to first `task dev` and first image build in under an hour, with
no production access and no real secrets. Owner-only operations are marked
👑 and live in the runbooks — you will not need them for ordinary work.

## 1. Toolchain

Install: Node 26 Active LTS (`.nvmrc` pins it — `nvm use`), `task`,
Docker (for image/integration work), `psql` 16+ client (optional; only for
native-PostgreSQL tasks). Never install `fly`/`neon` auth or cloud
credentials — local work needs neither.

```sh
git clone <repo> && cd openlevel
nvm use                      # install 26.x first if needed (see below)
task doctor                  # must be OK (INFO rows optional)
task tools:plan              # per-host compatible routes if anything is missing
task deps:install            # reproducible npm ci (same as CI)
```

Node manager missing? `task tools:install CONFIRM_TOOL_INSTALL=yes` applies
safe per-user steps and prints exact owner commands for the rest. Details +
per-host records: `docs/development/TOOLCHAIN_COMPATIBILITY.md`.

## 2. First run

```sh
task dev                     # PGlite API :8790 + Vite UI :5273, opens the browser
```

Login with the seeded dev operator (`admin@acmecorp.com` / `openlevel` —
dev-only stub, printed by the API on boot). The database is in-memory
PGlite: fresh on every boot, resets on restart. Nothing leaves your laptop:
providers are stubbed (Claude drafts canned, Chatwoot sends faked with
`dev-out-*` ids), workflows run in-process, secrets are dev defaults.

Useful next commands: `task dev:health` (probe both servers),
`task test` (full suite), `task check` (tests + typechecks + build),
`task build` (Vite bundle).

## 3. How the pieces fit (five-minute map)

- `server/index.ts` — bootstrap (config → pools → pg-boss → routes →
  listen) plus `ROLE`/`SIGTERM`/readiness wiring. Pure `createApp` stays
  test-friendly; only `bootstrap` touches the world.
- `server/routes/` — one file per surface, all mutations through
  `server/repos/` (never raw SQL in routes except operator-scoped
  push-tokens). Public capture (`public-*`) records timeline + dispatches
  automations; operator routes sit behind session + location membership.
- `server/jobs/` — pg-boss queues + workers; the workflow runner logs SMS/
  email honestly (`logged`, never `sent`). Workflow `wait` steps are
  disabled by default and fail loudly when reached — nothing parks waits
  in-process (see §4).
- `db/schema.sql` — the whole schema, idempotent; exec'd by dev-server and
  every PGlite test. `db/migrations/` — the same baseline, versioned, for
  releases (keep both in sync — see §6).
- `src/` — React/Vite SPA, same-origin `/api` (dev proxy only).
- `phase0/` — the separate DBOS proof harness. Different Dockerfile, schema,
  and acceptance criteria — do not mix it with product work.
- `Taskfile.yml` — the only command interface (`task --list`).

## 4. Tests and checks

```sh
task test                    # app suite (PGlite-backed, ~2 min)
task test:pg                 # real-PostgreSQL suite (testcontainers PG 18.7; needs Docker, honest NOT RUN without it)
task test:phase0:unit        # DB-free proof contracts (seconds)
task typecheck                # root tsc (same as CI)
task check                   # the local gate: test + typechecks + build
task test:phase0:integration # needs Docker; honest NOT RUN without it
```

The suite must be fully green — there are no pinned baseline failures
(the old vault exemption was removed with the FIND-11 root-cause fix).
Anything red is yours to fix. Never weaken or delete a test to get green.

Worker note (root-caused 2026-11-19, not a guess): 16-way default
parallelism OOM-kills workers on a 12 GB host (kernel `oom-kill` in
dmesg; a serial full run stays green, so this is memory saturation, not
a test leak). On a constrained host run
`npx vitest run --maxWorkers=4` — the supported host setting, and what
CI's required gate uses (`tests.yml`; default parallelism runs there as
an advisory-only signal). CI also runs `test:pg` with a hash-verified
dbmate — the adoption, race, and DBOS-pilot proofs live there.

The product MVP is one journey — lead capture → contact upsert →
timeline → operator visibility → booking — proven end to end by
`server/routes/mvp-journey.pg.test.ts` (12 acceptance points, real PG).
Workflow `wait` steps are disabled by default; the DBOS lead-follow-up
pilot (`server/dbos/`, ADR-002) is proven but NOT adopted — do not wire
new production paths to either engine without a new ADR.

## 5. Secrets you (don't) need

Basic development needs zero real secrets. If you ever need a real
**dev-only** provider key (never staging/production):

```sh
task secrets:status          # FOUND/MISSING per name — values never shown
secret-tool store --label=openlevel-dev openlevel ACME_ANTHROPIC_API_KEY
node scripts/lib/secret-store.mjs exec -- npm run dev:local
```

Rules: OS store only (Keychain / libsecret), never files; never print,
paste, or commit values; per-client keys resolve via `resolveSecret` so the
agent/tools never see them. Full policy:
`docs/security/SECRETS_MANAGEMENT.md`.

## 6. Migrations discipline (read before touching the DB)

Two artifacts, one rule — **both move together**:

1. `db/migrations/<timestamp>_name.sql` — the versioned migration dbmate
   runs on release (`-- migrate:up` required; `-- migrate:down` honest —
   no-op when forward-only).
2. `db/schema.sql` — the consolidated schema dev/PGlite execs. Apply your
   migration's final state here too (idempotent `IF NOT EXISTS` style).

Additive only on shared envs; destructive changes need explicit owner
approval + a backout plan. Verify locally against ephemeral PG 18.7
(`docker run … postgres:18.7` + `npm run db:migrate:release` with a local
URL, `?sslmode=disable` for the local container only).

`db:migrate:release` needs a dbmate binary: `DBMATE_BIN` env or `dbmate`
on PATH. Install v2.38.1 (the pinned release) — download the
`dbmate-linux-<arch>` asset from amacneil/dbmate releases into
`~/.local/bin`, verify its sha256 against the hash recorded in the
`Dockerfile`, `chmod +x`. Never use `/tmp` (it evaporates mid-session).

## 7. Environments and what you may touch

| Env | Fly app | You may | You may not (👑 owner) |
|---|---|---|---|
| Local | — | everything via `task dev`, PGlite | — |
| Dev | `openlevel-dev` | propose changes, review | deploy, secrets, provision |
| Staging | `openlevel-staging` | review, smoke after release | deploy, secrets, provision, data |
| Prod | `openlevel-prod` | nothing (prepared, not live) | everything |

Commands carry their safety class in `task --list`: local vs development /
staging / production cloud operations. Cloud tasks refuse without explicit
confirmation, and production needs double confirmation. `task env:status` /
`task env:validate` show the deployable surface without touching clouds.

Staging behavior differs from local by server-enforced containment, not
just policy: outbound sends sink (allowlisted recipients only), voice
sinks, push suppresses, social/Square/live-Stripe refuse, federation is
tenant-allowlisted, and workflow waits are disabled. Details + the exact
controls: [FLY_NEON.md](../deployment/FLY_NEON.md) §9, §16, §18, §20
and [ENVIRONMENTS.md](../deployment/ENVIRONMENTS.md) §1.

## 8. Building the deployment image

```sh
docker build -t openlevel:local-check .
docker run --rm openlevel:local-check sh -c "test -f dist/index.html && echo bundle-ok"
```

Local builds are pre-push verification only — nothing local is ever
deployed. CI (`product-packaging.yml`) builds ONCE per master push,
smokes the image (boot chain, dbmate release + reapply on PG 18.7,
DB-backed boot with `/health` + `/ready`, SPA serving, no-seed proof,
boot-log release line, SIGTERM exit 0, leak grep), and pushes it to
GHCR; that digest is what deploys and promotes across envs. If your
change touches boot, migrations, health, or the Dockerfile, rehearse the
matching CI step locally before pushing.

## 9. Troubleshooting

- `node … is below the repository runtime` → `nvm use` (repo needs 26).
- Port busy (`8790`/`5273`) → `task dev:health` says who; stop the other
  copy (never `kill -9` a shared DB — PGlite is in-process, safe to Ctrl-C).
- `DATABASE_URL is not set` → local real-PG tasks only; export a LOCAL url
  (the guard refuses remote ones) or just use `task dev` (PGlite).
- Docker unavailable → image + integration suites report NOT RUN honestly;
  everything else still runs.
- `fly:`/`neon:` errors about auth → expected: those CLIs are owner-operated;
  you don't need them for development.
- Flaky PGlite test → rerun the single file; cold WASM starts can exceed
  timeouts on loaded machines (30s budget per file).

## 10. Where to go next

- Product direction + staging limits: `docs/deployment/FLY_NEON.md` §20–§21.
- Environment topology + Twelve-Factor map:
  `docs/architecture/ENVIRONMENT_ARCHITECTURE.md`.
- Provisioning/promotion/approvals: `docs/deployment/ENVIRONMENTS.md`.
- Daily workflow + toolchain records: `docs/development/LOCAL_DEVELOPMENT.md`,
  `docs/development/TOOLCHAIN_COMPATIBILITY.md`.
