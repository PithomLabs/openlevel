# OpenLevel environments: provisioning, promotion, and approval boundaries

How to provision and operate the three environments. Architecture rationale:
`docs/architecture/ENVIRONMENT_ARCHITECTURE.md`. Secrets rules (names only,
rotation, incidents): `docs/security/SECRETS_MANAGEMENT.md`. Staging
release runbook: `docs/deployment/FLY_NEON.md`.

**Standing rule (AGENTS.md #9): nothing in this file authorizes cloud
mutations.** Every provisioning, deploy, secret, and database step is
owner-executed with a separate explicit authorization per action. The coding
agent prepares procedures; the owner runs them.

## 1. Environment matrix

| Concern | Development | Staging | Production |
|---|---|---|---|
| Fly app | `openlevel-dev` (`fly.dev.toml`) | `openlevel-staging` (`fly.toml`) | `openlevel-prod` (`fly.prod.toml`) |
| `APP_ENV` / `NODE_ENV` | development / production | staging / production | production / production |
| Neon resources | Isolated dev DB/branch | Dedicated staging DB | Dedicated production project |
| `DATABASE_URL` | Dev-only, direct, TLS | Staging-only, direct, TLS | Prod-only, direct, TLS |
| App secrets | Dev-only generated | Staging-only generated | Prod-only generated |
| Provider keys | Stubs or dev keys | Restricted staging keys | Production keys |
| Data | Synthetic | Synthetic/sanitized | Customer (owner-gated import) |
| Messaging | Stub/sandbox | Test destinations | Approved prod provider |
| Outbound fence | Off (loopback-local) | Sink + allowlists, code-enforced (`STAGING_SINK_ALLOWLIST`, `FEDERATION_TENANT_ALLOWLIST`) | Full providers (owner-gated) |
| Workflow waits | Explicit opt-in (dev) | DISABLED (`WORKFLOW_WAITS_ENABLED` unset) | DISABLED until a proven engine |
| Topology | 1× `all` (or local) | 1× `all` | 1× `all` prepared; HA owner-decided |
| Logs | Local / dev app | Staging app | Production app |
| Deploy auth | Owner per command | Owner per command | Owner double confirmation |
| Migrations | dbmate / local replay | dbmate `release_command` | dbmate `release_command`, approved |
| Backups | None required | Disposable (rebuild) | PITR + rehearsed restore (gate) |
| Resource owner | Developers | Owner | Restricted operators |

## 2. Provisioning: development (`openlevel-dev`)

Owner-executed, in order:

1. Create the Neon dev database (new disposable project or isolated
   branch — never the staging/prod project). Note the **direct** endpoint.
2. `fly apps create openlevel-dev -o <confirmed-org>`, then set the confirmed
   region as `primary_region` in `fly.dev.toml` (region follows the pilot
   geography decision shared with staging; the deploy guard refuses without it).
3. Generate dev-only secrets (32+ chars; see secrets doc for the safe
   generation pattern — values never leave the owner's terminal).
4. `fly secrets set -a openlevel-dev` each name from the inventory
   (`DATABASE_URL` with `?sslmode=require`, `SESSION_SECRET`,
   `CHATWOOT_WEBHOOK_SECRET`, rails only if the dev gateway exists).
5. `task deploy:dev CONFIRM_DEPLOY=yes` (guard validates app+config match).
6. `fly scale count 1 -a openlevel-dev`; verify `/ready` 200, one Machine,
   migration evidence in release logs.

## 3. Provisioning: staging (`openlevel-staging`)

Same shape, staging-owned resources. Full 21-section procedure (topology,
CLI versions, secrets, build, release, verification, rollback, limits):
`docs/deployment/FLY_NEON.md`. Summary:

1. Dedicated Neon staging DB (direct endpoint, `sslmode=require`).
2. `fly apps create openlevel-staging -o <confirmed-org>`, then set the confirmed
   region as `primary_region` in `fly.toml` (deploy guard refuses without it).
3. Staging-only secrets via `fly secrets set`.
4. Staging fence controls (plain env, fail-closed when absent):
   `STAGING_SINK_ALLOWLIST` (test recipients), `FEDERATION_TENANT_ALLOWLIST`
   (synthetic location IDs). Leave `WORKFLOW_WAITS_ENABLED` unset.
5. `task deploy:staging CONFIRM_DEPLOY=yes`; `fly scale count 1`.
6. Acceptance (§15 sequence in the runbook): `/health` 200, SPA loads,
   staging login, read/write, both workers registered, one Machine,
   migration evidence, no credentials in logs, MVP journey passes.

## 4. Provisioning: production (`openlevel-prod`)

Three states — do not conflate them:

1. **Provisioned** — this section. Infrastructure exists; app may be absent.
2. **Release-ready** — all 14 production gates pass (runbook checklist).
3. **Live** — separate owner authorization: first prod release, customer
   data, integrations, DNS, traffic.

Provisioning steps (owner, after staging acceptance):

1. New dedicated Neon **project** for production (not a branch of dev/staging).
2. Least-privilege roles: distinct migrator and runtime roles (staging's
   single role is explicitly not production-grade).
3. `fly apps create openlevel-prod -o <confirmed-org>`, then set the confirmed
   production geography as `primary_region` in `fly.prod.toml`.
4. Production-only secrets (freshly generated; nothing copied).
5. PITR/backup configured AND the restore rehearsal executed with evidence
   (§7) — before any customer data exists.
6. Deploy the prepared image only after the gate checklist passes; verify
   like staging, plus prod sizing/topology decisions recorded.

Until step 6's gates pass, `fly.prod.toml` is a prepared definition — the
app stays down. Deploying to it early proves nothing and risks everything.

## 5. Deployment and promotion

```
commit → CI (product-packaging + phase0) → GHCR digest
  → task deploy:dev → task promote:staging → staging acceptance
  → owner production approval → task promote:production → post-release verify
(direct `task deploy:<env> IMAGE_DIGEST=…` only when promotion cannot apply,
e.g. a first deploy — digest always from the CI artifact, never rebuilt.)
```

- Same digest promotes; never rebuild per env. Promote tasks resolve the
  source digest once and verify equality (no TOCTOU).
- Every deploy runs the unified guard (explicit app+config, in-repo
  config, P2 refusal, config↔app match, `primary_region` present,
  prod double-confirm via exact env→app mapping, owner confirmation).
- `release_command` (`npm run db:migrate:release`) migrates before traffic;
  failure fails the release. Logs are credential-free.
- Release identity (commit + digest + migration version + env) is recorded
  for every release; `task release:status` shows history.
- Rollback: `task release:rollback` with an EXPLICIT prior digest
  (`--image …@sha256:… --rollback`, never a floating tag); app-only —
  the database never rolls back. Staging schema stays additive so
  rollback stays safe.

## 6. Database resources and release commands

- One migration tool (dbmate 2.38.1, pinned in-image) across dev/staging/prod
  release paths; `db/schema.sql` stays the dev/PGlite bootstrap and mirrors
  every migration's final state (consolidated-schema discipline).
- Baseline `20261119000000` (audited: 139 CREATE + 10 ALTER, all idempotent).
  New migrations: additive, versioned, forward-recovery planned; destructive
  changes need explicit owner approval and a backout plan.
- Local real-PG work uses the guarded `task db:*` tasks (local URLs only —
  the guard refuses remote targets).
- Direct Neon endpoints everywhere; pooled endpoints only after proving
  pg-boss compatibility (not proven — do not switch).

## 7. Backup and recovery (incl. the PITR rehearsal gate)

- **Staging/dev**: disposable. Recovery = re-provision + re-deploy + re-seed
  synthetic data. No backup theater.
- **Production**: Neon backup/PITR configured per the Neon docs, PLUS —
  **acceptance gate, no exceptions** — at least one executed end-to-end
  restore rehearsal with dated evidence before production is declared
  operationally ready:
  1. Restore to an isolated branch (never over production).
  2. Consistency checks (table counts, constraint validation, app boot
     against the restored branch in a scratch env, `/ready` 200).
  3. Redeploy procedure rehearsed against the restored data.
  4. Secret recovery path rehearsed (re-issue from the approved source).
  5. Evidence recorded: date, operator, branch IDs, check outputs, issues
     found and fixed. Documentation alone is not evidence.

## 8. Verification and rollback per env

- Verify after every release: `/health` 200, `/ready` 200, Machine count 1,
  release logs show migration `Applied:` (or clean no-op), no credentials
  in logs, smoke the MVP journey on staging.
- Rollback app: explicit prior image via `task release:rollback`.
- Rollback data: there is none — forward-recovery only. If a migration
  corrupts staging, rebuild staging (disposable). If a migration threatens
  production, that is what the staging gate + additive-only rule prevent;
  the PITR rehearsal (§7) is the last resort, executed by the owner.

## 9. Owner approval boundaries

| Action | Authorizer |
|---|---|
| Provision any Fly/Neon resource | Owner, per resource |
| Set/rotate any cloud secret | Owner, per app |
| `task deploy:dev` / `deploy:staging` | Owner, per command (`CONFIRM_DEPLOY=yes`) |
| `task deploy:production` | Owner, per command (double confirm) |
| `task release:rollback` (any env) | Owner, per command (double for prod) |
| First production release | Owner, after all 14 gates pass |
| Customer data import, DNS, traffic | Owner, each separately |
| Destructive migration | Owner, with backout plan |
| CI touching Fly/Neon | Never — CI is hermetic by design |

The coding agent never performs these under implementation authorization.
"Go" on the implementation plan authorized local work only.
