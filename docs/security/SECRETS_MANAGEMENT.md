# OpenLevel secrets management

Names, classification, storage, injection, rotation, and incident response
for every secret OpenLevel uses. **This document names secrets; it never
holds values.** Any value appearing here (or in chat, code, configs, logs,
CI, or images) is a release-blocking defect — see Incident response.

Canonical code: `server/lib/secrets.ts` (`SECRET_ENV_VARS`, redaction) and
`server/lib/config.ts` (validation). Local workflow: `task secrets:status`.

## 1. Inventory (names only)

Discovered from the actual configuration (`server/lib/config.ts`,
`server/index.ts` bootstrap, `server/lib/vault.ts`, `db/*`).

| Name | Purpose | Owner | Consumer | Classification |
|---|---|---|---|---|
| `DATABASE_URL` | Postgres connection (app pools, pg-boss, dbmate) | Neon project per env | server bootstrap, release_command | database credential |
| `SESSION_SECRET` | Operator session HMAC + cookie signing | Generated per env | `operatorAuth`, login/logout | signing key |
| `CHATWOOT_WEBHOOK_SECRET` | Chatwoot inbound webhook HMAC (`X-Chatwoot-Signature` header, HMAC-SHA256 over `timestamp.rawBody`; `?secret=` removed 2026-11-19) | Generated per env (must match Chatwoot) | webhooks-chatwoot route | app secret |
| `FEDERATION_SERVICE_TOKEN` | Hub gateway bearer for `/federation/*` | Hub gateway operator | federation route (unset ⇒ 503) | provider credential |
| `INTERNAL_PUSH_SECRET` | Internal bearer for the text/push gateway rails | Gateway operator | send-text rail, push notifier | provider credential |
| `GATEWAY_TEXT_URL` | Text-rail endpoint (URL, not a credential) | Gateway operator | send-text rail | public config |
| `GATEWAY_PUSH_URL` | Push endpoint (URL, not a credential) | Gateway operator | push notifier | public config |
| `<SLUG>_ANTHROPIC_API_KEY` | Per-client Anthropic key, resolved by `resolveSecret("<slug>:anthropic:api_key")` | Client's Anthropic account | agent engine, operator assistant | provider credential |
| `<SLUG>_CHATWOOT_API_TOKEN` | Per-client Chatwoot token, resolved by `resolveSecret("<slug>:chatwoot:api_token")` | Client's Chatwoot account | outbound composer, agent replies | provider credential |
| Neon API token | `neon` CLI / API management (projects, branches) | Neon org owner | Owner's workstation only, never the app | infrastructure credential |
| Fly API token | `fly` CLI deploys / secrets / machines | Fly org owner | Owner's workstation only, never the app | infrastructure credential |

Non-secret configuration (same names everywhere, values differ per env):
`NODE_ENV`, `APP_ENV`, `PORT`, `ROLE`. Staging fence controls (non-secret,
fail-closed when absent): `STAGING_SINK_ALLOWLIST`,
`FEDERATION_TENANT_ALLOWLIST`, `WORKFLOW_WAITS_ENABLED` (default `false`).
Dev-only: `OPENLEVEL_HOST`, `OPENLEVEL_API_PORT`, `OPENLEVEL_WEB_PORT`.

Tenant secret namespaces (N7): every location's effective slug
(`client_slug ?? slug`) must be unique under separator/case normalization
— boot refuses colliding locations (e.g. `acme-corp` vs `acme_corp`) so
two tenants can never silently share one vault credential. The lookup
itself stays lossy by design (flat env keys); uniqueness is the guard.

Federation trust (N9): the service bearer authenticates the hub gateway;
the tenant it names is allowlist-bound server-side
(`FEDERATION_TENANT_ALLOWLIST`), fail-closed in staging. Production
per-tenant token binding is an explicit owner gate, not this list.

## 2. Classification rules

- **Database credential** — full data access. Least privilege per env;
  migrator vs runtime split is a production gate (§8).
- **Signing key** — forges sessions. 32+ chars, generated, per env.
- **App secret** — webhook HMAC. 32+ chars, generated, per env.
- **Provider credential** — third-party bearer/token. Scoped to the owning
  account; staging never holds production provider keys.
- **Infrastructure credential** — manages the platform itself. Owner-only;
  never enters the app, CI, or chat.
- **Public config** — URLs and flags. Safe in configs/docs; still validated.

Nothing is "non-sensitive because it is in an env var". When in doubt,
classify up.

## 3. Storage

| Context | Store |
|---|---|
| Local dev (basic) | No store needed: PGlite, dev defaults, stubbed providers |
| Local dev (real dev-only key) | OS credential store — macOS Keychain, Linux libsecret (`secret-tool`); see §5 |
| Fly runtime (all envs) | `fly secrets` per app; separate inventories, never synced across envs |
| Neon credentials | Neon project dashboard; connection strings go straight into the matching Fly app's secrets |
| CI | No stores: temp inline values only, obviously fake |

Forbidden everywhere: `.env` / `.env.*` files with real values (git-ignored
AND docker-ignored), YAML/JSON/TOML/Taskfiles, Docker build args, image
layers, test fixtures, chat, screenshots, shell history (prefer `fly secrets
set NAME` reading from stdin or a secrets-manager pipe over `-v` argv).

## 4. Runtime injection (Fly)

Secrets arrive as env vars at process start via `fly secrets set` per app.
The app validates at boot (`loadConfig` + `isCloudEnv`): outside
development, `SESSION_SECRET` / `CHATWOOT_WEBHOOK_SECRET` must be overridden
away from dev defaults and be 32+ chars; set-but-short bearers
(`FEDERATION_SERVICE_TOKEN`, `INTERNAL_PUSH_SECRET`) refuse to boot; an
unknown `APP_ENV` refuses to boot. `APP_ENV` is then cross-checked
against `FLY_APP_NAME` and the `DATABASE_URL` host (exact mapping —
staging never boots against a prod database). A missing production
secret prevents startup — fail closed, never a dev default in the
cloud.

Restart behavior: changing a Fly secret restarts Machines (new processes get
the new value). Rotation order is new-value-first (§7) so the restart window
stays safe.

## 5. Local developer workflow

```sh
task secrets:status   # FOUND/MISSING per name — values never printed
```

To use a real dev-only key once (never a staging/production value):

```sh
# store it (Linux; macOS: Keychain Access, service "openlevel")
secret-tool store --label=openlevel-dev openlevel ACME_ANTHROPIC_API_KEY
# run anything with store-held secrets injected (memory-only, never logged)
node scripts/lib/secret-store.mjs exec -- npm run dev:local
```

`task dev` itself needs no secrets and stays that way.

## 6. Redaction and leak prevention

- Central scrubbers: `redactText` (known values), `redactUrl` (structural
  password masking), `safeError`/`formatSafeError` (name+message+scrubbed
  stack; bespoke error fields dropped). Every error surface routes
  through the single `reportError` boundary with an `env=` tag: Hono
  `onError` (request path), `uncaughtException`/`unhandledRejection`,
  pool/boss error handlers, boot/shutdown cleanup, `db/migrate.ts`, and
  the dbmate release path (dbmate logs `Applying:`/`Applied:` only —
  verified credential-free). No `console.error(err)` with a raw error
  anywhere on the request or boot path (canary-throw e2e proves it).
- Vault lookups are case-insensitive and case-preserving; a lookup
  matching two distinct stored names throws (ambiguity) rather than
  guessing.
- Health/readiness expose enums only (`/health` liveness, `/ready` with
  `starting|shutting-down|db|db-timeout`); configs are never serialized.
- Canary tests (`server/lib/secrets.test.ts`) prove fake secrets vanish from
  every scrubber output; the honesty lock (`workflow-runner.test.ts`) pins
  log-only wording.
- Build/CI controls: `.dockerignore` excludes `.env*`, `*.pem`, `*.key`,
  credential-export names (`creds.json`, `secrets-export.json`,
  `*-credentials.csv`, keystores, SSH keys — N6, both ignore files);
  Dockerfiles `COPY` explicit paths only; CI asserts no `.env` in the image,
  greps captured logs for the temp credential, and uses zero `secrets.*`.
- GitHub secret scanning / push protection: recommended owner setting (see
  runbook) — automation, not a substitute for the rules above.

## 7. Rotation and revocation

Per secret, per env (record completion with names + timestamps, never values):

1. Generate/issue the replacement (32+ chars CSPRNG for app keys; provider
   consoles for provider keys; `ALTER ROLE ... PASSWORD` / Neon dashboard
   for database passwords).
2. `fly secrets set NAME` on the affected app only (staging and production
   rotate independently).
3. Verify: `fly status`, `/ready` 200, exercise one write path, check logs
   show the new deployment healthy.
4. Revoke the previous credential at its owner (provider console, Neon,
   `fly secrets unset` only after confirming nothing else references it).
5. Record: secret name, env, date, operator, verification evidence.

Database URLs rotate as a unit (user+password+host); the app has no
connection-string caching beyond pool lifetime, so a Machine restart (step
2 triggers it) picks the new value up. Session-secret rotation invalidates
all operator sessions (re-login required) — announce before rotating.

## 8. Production gates (secrets)

- Migrator vs runtime database roles are split and least-privilege (staging
  uses one simplified role — documented, not production-grade).
- Every production secret is generated fresh; nothing copied from staging/dev.
- Rotation runbook rehearsed at least once on staging before production use.
- Incident response below is read and reachable by every operator.

## 9. Incident response (exposed credential)

1. **Contain first**: revoke/rotate the exposed credential immediately (§7).
   Do not pause to investigate while a live secret is public.
2. Assess scope: which envs, which commits/logs/images/CI artifacts carry it.
3. Purge: rotate everywhere it appeared (a secret in Git history is
   compromised forever — rotation, not history rewrite, is the fix).
4. Record: what leaked, where, when, rotation evidence, follow-up (rule or
   automation that would have caught it).
5. If customer data could have been reached with it, treat it as a data
   incident per the owner's policy — not just a credential rotation.
