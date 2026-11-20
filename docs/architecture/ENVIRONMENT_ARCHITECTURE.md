# OpenLevel environment architecture

The three-environment strategy, the Twelve-Factor assessment it rests on,
and the boundaries that keep development, staging, and production from
contaminating each other. Runbooks (`docs/deployment/`) and onboarding
(`docs/development/DEVELOPER_ONBOARDING.md`) implement this document; on
conflict, this document wins for architecture, the runbooks win for commands.

## 1. Topology

One codebase, one image, three isolated environments:

```
                        OPENLEVEL
                            |
                      One Codebase (git)
                            |
                  Immutable Image (digest-pinned per release)
                            |
            +---------------+---------------+
            |               |               |
       DEVELOPMENT       STAGING       PRODUCTION
            |               |               |
  openlevel-dev (*)   openlevel-      openlevel-prod
                      staging         (PROVISIONED,
            |               |          NOT LIVE)
         Neon dev        Neon staging  Neon prod
         (isolated)      (dedicated)   (dedicated project)
            |               |               |
        Synthetic       Synthetic/      Customer data
        data            sanitized       (owner-gated)
```

(*) Shared cloud dev env. Day-to-day development is local-first (PGlite,
`task dev`) with no cloud dependency; `openlevel-dev` exists for integration
experiments and collaboration.

Each environment owns its Fly app, Neon resources, secrets, data, logs, and
release history. Nothing is shared across the lines — especially not
credentials or customer data.

## 2. Configuration contract

One typed schema (`server/lib/config.ts`), same variable names everywhere,
different values per env:

| Variable | dev (local) | dev (cloud) | staging | production |
|---|---|---|---|---|
| `APP_ENV` | development | development | staging | production |
| `NODE_ENV` | development | production | production | production |
| `PORT` | 8790 | 8790 | 8790 | 8790 |
| `ROLE` | all | all | all | all (split later) |
| `DATABASE_URL` | PGlite / local PG | dev Neon (direct, TLS) | staging Neon (direct, TLS) | prod Neon (direct, TLS) |
| `SESSION_SECRET` | dev default | generated, dev-only | generated, staging-only | generated, prod-only |
| `CHATWOOT_WEBHOOK_SECRET` | dev default | generated, dev-only | generated, staging-only | generated, prod-only |
| `FEDERATION_SERVICE_TOKEN` | unset (503) | dev-only or unset | staging-only or unset | prod-only or unset |
| `GATEWAY_TEXT_URL` / `GATEWAY_PUSH_URL` | unset | dev endpoints | staging endpoints | prod endpoints |
| `INTERNAL_PUSH_SECRET` | unset | dev-only or unset | staging-only or unset | prod-only or unset |
| Per-client `<SLUG>_*` keys | stubs | dev keys | staging keys | prod keys |

`APP_ENV` identifies the environment; `NODE_ENV` is a build hint.
Validation is fail-closed on either signal (`isCloudEnv`): any
non-development `APP_ENV`, OR `NODE_ENV=production`, enforces overridden
32+ char secrets and rejects unknown `APP_ENV`. The `NODE_ENV` backstop is
load-bearing for cloud dev (`APP_ENV=development` there would otherwise run
with dev defaults) — never remove it without a replacement.

Full matrix with owners and authorization: `docs/deployment/ENVIRONMENTS.md`.

## 3. Process topology

| Role | Listens | pg-boss | Use |
|---|---|---|---|
| `all` | yes | consumes | Staging, dev, and initial prod shape |
| `web` | yes | send-only (enqueue, never consume) | Future split |
| `worker` | no | consumes | Future split |

One image serves all roles (`ROLE` selects). pg-boss requires `start()`
before `send()`, so every role starts boss; only `worker`/`all` register
consumers. Staging runs exactly one `all` Machine by design (cost +
blast radius). Workflow `wait` steps are DISABLED by default
(`WORKFLOW_WAITS_ENABLED` unset): reaching one fails the run loudly
instead of arming the legacy pg-boss machinery (Review 12 N2/N3). The
DBOS lead-follow-up pilot passed 9/9 proofs (ADR-002) as the candidate
replacement, but no cutover has occurred — scale-out stays a topology
decision, and the role split still needs only process-group config.

Shutdown (all roles, verified live): SIGTERM → `/ready` flips 503 →
listener closes (5s grace, then force) → `boss.stop({timeout: 15s})` →
pools close, inside a 25s deadline under Fly's 30s `kill_timeout`. A second
signal exits immediately. Exit 0 clean, 1 on overrun.

## 4. Database isolation

- Distinct Neon projects/branches per env; production gets its own project
  (a branch is not a security boundary).
- Direct (non-pooled) endpoints with `sslmode=require` for app + migrations
  (pg-boss needs session semantics; dbmate needs a stable session).
- Credentials never cross envs; staging tests never touch prod; prod data is
  never restored into dev/staging without an approved sanitization pipeline
  (which does not exist yet — so never, for now).
- Migrations are versioned (dbmate, baseline `20261119000000`) and run via
  `release_command` before traffic; staging history is additive-only and its
  data disposable. Migrator/runtime role split is a production gate —
  staging honestly runs one simplified role.

## 5. Artifact promotion

```
commit → CI build+verify → image digest → dev → staging → (acceptance) → owner approval → prod
```

The same digest promotes; releases never rebuild per env. A release is
identified by commit + digest + migration version + target env. Rollback is
app-only (`task release:rollback` with an explicit image ref); the database
never rolls back — forward-recovery only.

## 6. Environment lifecycle

- **Provision** (owner): Fly app + Neon resources + secrets per
  `docs/deployment/ENVIRONMENTS.md`. Provisioning ≠ activation.
- **Release** (owner-authorized per command): guarded deploy tasks, migration
  evidence, `/ready` + smoke verification.
- **Operate**: env-aware logs (`env=` on every bootstrap line), per-env Fly
  logs, `/ready` checks, DLQ inspection for failed jobs.
- **Recover**: re-deploy a known image; database recovery via Neon
  backup/PITR (production requires a rehearsed restore — acceptance gate).
- **Retire**: `fly apps destroy` + Neon project deletion + credential
  revocation, recorded per the secrets runbook.

Environments are reconstructible from this doc + the runbooks + the three
`fly.*.toml` files. No undocumented live edits; drift is a bug.

## 7. Twelve-Factor assessment

| Factor | Verdict | Notes |
|---|---|---|
| I Codebase | ✅ | One repo; releases identified by commit+digest |
| II Dependencies | ✅ | Lockfile + `npm ci`; Node 26 LTS everywhere; no global runtime deps |
| III Config | ✅ | Typed env schema; same names, per-env values; fail-closed |
| IV Backing services | ✅ | PG/Neon/providers attached via config; isolated per env |
| V Build/release/run | ✅ | Immutable image; release = image + config + migrations; CI builds, Fly releases |
| VI Processes | ⚠️ adapted | Stateless; workflow `wait` steps are disabled by default (loud failure, no stranding) until a proven durable engine replaces the legacy pg-boss machinery (DBOS pilot passed, not adopted — ADR-002) |
| VII Port binding | ✅ | `PORT` honored; Fly `internal_port` matches; checks use the service port |
| VIII Concurrency | ✅ | `web`/`worker`/`all` roles, one image; staging on `all` by design |
| IX Disposability | ✅ | Verified SIGTERM drain; fast boot; crash-only worker design |
| X Dev/prod parity | ⚠️ adapted | Same image/config names/migration tool; PGlite↔PG and stubbed↔real providers are explicit, tested divergences |
| XI Logs | ✅ | Plain-text stdout/stderr lines (not JSON) with `env=` context on boot/signal/error lines; centralized redaction + canary tests; no secret/config serialization |
| XII Admin processes | ✅ | Migrations/seeds are one-off processes (release_command, guarded local tasks); no boot-time auto-migrate, no auto-seed |

The VI and X adaptations are deliberate, documented, and gated — not
drift. (VI returned to adapted 2026-11-19: Review 12 withdrew the
durable-waits claim; waits stay disabled pending a proven engine.)

## 8. Remaining architectural deviations

1. Workflow SMS/email actions log honestly but deliver nothing (campaigns
   deliver for real through connected providers).
2. DBOS pilot passed but is not adopted; pg-boss is the execution engine
   (deliberate — ADR-002).
3. Migrator/runtime DB roles are not split (staging simplification).
4. RLS deferred per V2.1; tenancy enforced in the repo layer + middleware.

Graduated 2026-11-19: entry convergence on all capture paths (manual add
included — the "manual add fires nothing" note was stale and is withdrawn);
event identity/dedup; owner-only RBAC; atomic booking/idempotency (N4);
release-path env identity (N1). Withdrawn same date: the Review-11
"durable waits" claim (Review 12 N2/N3 — waits are disabled by default).

Each is a tracked production gate or an accepted staging limitation — see
`docs/deployment/FLY_NEON.md` (gate checklist) and the Review-5
reconciliation in the implementation report.
