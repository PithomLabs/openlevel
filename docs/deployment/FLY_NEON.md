# OpenLevel staging deployment runbook (Fly.io + Neon)

Build, release, verify, and roll back the staging MVP. Architecture:
`docs/architecture/ENVIRONMENT_ARCHITECTURE.md`. Environments and
approvals: `docs/deployment/ENVIRONMENTS.md`. Secrets (names only):
`docs/security/SECRETS_MANAGEMENT.md`. This runbook references those —
it does not duplicate them.

**Authorization:** implementation work never authorizes cloud mutations.
Every Fly/Neon step below is owner-executed with separate explicit approval
(see §7 and `ENVIRONMENTS.md` §9). Never paste credentials into chat.

## 1. Architecture and staging topology

One `all`-role Machine (`openlevel-staging`): Hono API + Vite SPA
same-origin + pg-boss consumers (`agent.reply.dispatch`,
`workflow.dispatch`, `outbox.sweep`) + `pg` pools → Neon staging Postgres
(direct, TLS). Scale count is exactly 1: a deliberate staging
simplification (cost + blast radius). Workflow waits are DISABLED by
default — a `wait` step fails its run loudly instead of scheduling —
so there is no `workflow.resume` consumer and no resume DLQ in staging
until a proven durable engine is adopted (Review 12 N2/N3; the Review-11
durability claim is withdrawn, and multi-Machine scale stays a topology
decision gated on that adoption).

## 2. Prerequisites and CLI/toolchain requirements

- Repo checkout at a known commit; `task doctor` OK (Node 26;
  `.nvmrc`/engines/CI/Dockerfiles all pin 26 — see
  `docs/development/TOOLCHAIN_COMPATIBILITY.md`).
- `task` 3.x; `flyctl` + `neon` CLIs installed (any recent stable; this
  runbook was verified against flyctl v0.5.13 + neon 2.35.1 — re-check
  `task fly:help` / `task neon:help` before trusting remembered syntax).
- Docker for local image verification.
- Owner-authenticated `fly` + `neon` CLIs (owner runs `auth login`).

## 3. Node and PostgreSQL versions

- Runtime: Node 26 Active LTS (v26.13.1 verified; `.nvmrc` 26).
- Image base: `node:26-slim` (floating within 26; digest recorded per release).
- PostgreSQL target: 18.7 (Nov 2026 stable; service/CI image
  `postgres:18.7`). Neon staging runs the Neon-supported PG 18 line.
- Phase 0 proof pins stay digest-pinned 16.16 (separate harness, separate
  acceptance — not the product target).

## 4. Neon staging project or branch preparation

Owner: create a DEDICATED staging database (new disposable project
preferred, or an explicitly isolated non-production database). Confirm it
holds no live customer state and is disposable. Record the project/branch
IDs (IDs, never credentials).

## 5. Direct endpoint selection

Use the **direct** (non-pooled) Neon endpoint with `sslmode=require` for
`DATABASE_URL` — migrations and pg-boss need session semantics the pooled
endpoint does not provide. Do not switch to pooling without a proven
compatibility run (none exists).

## 6. Database role and privilege requirements

Staging honestly runs ONE simplified role (documented, not
production-grade). The migrator/runtime least-privilege split is a
production gate (§21, item 8) — do not claim it here.

## 7. Fly organization and application preparation

Owner:

```sh
fly auth login
fly apps create openlevel-staging -o <confirmed-org>
```

(`fly apps create` takes no `--region` on the verified flyctl — region is
declared via `primary_region`, §8.) Verify:
`task fly:status FLY_APP=openlevel-staging`.

## 8. Fly region selection procedure

1. Confirm the first pilot's geography with the owner.
2. Pick the Fly region serving it with acceptable latency.
3. Confirm Neon availability in a matching region.
4. Record the decision (region + date + who confirmed) in the release notes.
5. Set the confirmed code as `primary_region` in the environment's
   `fly.*.toml` (top-level key, next to `app`). The deploy guard refuses
   any deploy whose config lacks it; `PRIMARY_REGION` then appears in the
   Machine runtime for verification. Never invent or default this value —
   without owner confirmation, provisioning stays blocked by design.

## 9. Required secret names (from the actual source configuration)

`DATABASE_URL` (direct, `?sslmode=require`), `SESSION_SECRET`,
`CHATWOOT_WEBHOOK_SECRET`, optionally `FEDERATION_SERVICE_TOKEN`,
`GATEWAY_TEXT_URL`, `GATEWAY_PUSH_URL`, `INTERNAL_PUSH_SECRET`, and any
staging `<SLUG>_*` provider keys. Non-secret env is already in `fly.toml`
(`NODE_ENV`/`APP_ENV`/`ROLE`/`PORT`). Full inventory + classification:
secrets doc. Application code reads these ONLY through the typed config
(`server/lib/config.ts`); boot refuses dev defaults and short bearers.

Non-secret staging controls (plain env, also fail-closed when absent):
`STAGING_SINK_ALLOWLIST` (comma-separated test emails/phones — required
before ANY staging send is accepted), `FEDERATION_TENANT_ALLOWLIST`
(synthetic location IDs the gateway may name). `WORKFLOW_WAITS_ENABLED`
stays unset (`false`) — staging never enables the legacy wait engine.

## 10. Secret creation with Fly secrets only

Owner, per name (values generated locally, never pasted anywhere else):

```sh
fly secrets set -a openlevel-staging DATABASE_URL
# (paste at the stdin prompt — never `-v` on the command line / history)
fly secrets set -a openlevel-staging SESSION_SECRET
fly secrets set -a openlevel-staging CHATWOOT_WEBHOOK_SECRET
# … rails / federation / provider keys only if staging uses them
```

Verify names (never values): `fly secrets list -a openlevel-staging`.
Staging secrets are staging-only; production gets fresh values later.

## 11. CI-built image and digest promotion (never rebuild per env)

CI (`product-packaging.yml`) builds the image ONCE per commit on master,
smokes it (boot chain, bundle, tsx loader, dbmate present, `.env` absent,
release-command equivalent + idempotent reapply on PG 18.7, DB-backed
boot with `/health` + `/ready` 200, SPA + refresh routing, no-seed
proof, boot-log release line, SIGTERM exit 0, credential-leak grep over
captured logs), and pushes it to GHCR (master pushes only, `GITHUB_TOKEN`
`packages:write` — no Fly/Neon credentials in CI). The workflow artifact
records the immutable digest (`ghcr.io/<owner>/openlevel@sha256:…`).
`tests.yml` runs the gates in parallel: three typechecks, the unit suite
(capped workers, required; default parallelism as an advisory signal for
the §12 saturation finding), and `test:pg` on testcontainers PG 18.7
with a hash-verified dbmate — zero `secrets.*` use anywhere.

Local `docker build` is for pre-push verification only. Every deploy
(§12) and promotion takes the exact CI-published digest — the same bytes
flow dev → staging → production. Never rebuild an image for an
environment and call it the same release.

```sh
task env:validate            # configs, image def, migrations, runtime
# digest comes from the CI artifact, not a local build
```

## 12. Fly release procedure

Owner — prefer promotion (verified digest equality, no hand-pasted ref):

```sh
task promote:staging CONFIRM_DEPLOY=yes
```

Direct digest deploy when promotion does not apply (first staging deploy,
digest from the §11 CI artifact):

```sh
task deploy:staging IMAGE_DIGEST='ghcr.io/<owner>/openlevel@sha256:…' CONFIRM_DEPLOY=yes
```

The unified guard enforces: explicit app+config, in-repo config, P2
refusal, config↔app match, `primary_region` present (§8), production
double-confirmation where applicable (exact env→app mapping, never a
name-substring check), owner confirmation, no inference.
`release_command` (`npm run db:migrate:release`) migrates before traffic;
failure fails the release. Then `fly scale count 1 -a openlevel-staging`
(exactly one).

## 13. Machine-count verification

```sh
task release:status FLY_APP=openlevel-staging
```

Exactly one Machine. More than one (or zero) is a failed release —
investigate before traffic.

## 14. Health-check verification

- `GET /health` → 200 (liveness).
- `GET /ready` → 200 `{"ready":true}` (lifecycle + live DB ping).
  Anything else (503 `starting|shutting-down|db|db-timeout`) means the
  instance must not take traffic — do not proceed to §18.
- `fly checks list -a openlevel-staging` shows the `/ready` check passing.

## 15. Migration verification

Release logs show `Applying: 20261119000000_baseline.sql` /
`Applied: …` on first deploy, clean no-op on later ones. Confirm via
`dbmate status` semantics (1 applied, 0 pending — CI proves the shape;
on Fly, read the release-command log). Failure anywhere here fails the
release — fix forward, never hand-edit the staging schema.

## 16. Application and background-worker verification

Logs show `api (role=all) listening` plus `workflow waits disabled —
resume worker not registered`, with three consumers registered
(agent-reply, workflow-dispatch, outbox-sweep workers complete before
ready — boot ordering is the boss-readiness proof). There is deliberately
no `workflow.resume` consumer and no `workflow.resume.dead` queue while
waits stay disabled. Exercise: send a test webhook →
`agent.reply.dispatch` + `workflow.dispatch` jobs flow; check pg-boss
DLQs (`agent.reply.dead`, `workflow.dispatch.dead`, `outbox.sweep.dead`)
stay empty on the happy path. The outbox sweeper runs every minute
(`outbox.sweep` cron); discovery and claim share one recoverability
predicate (pending-due plus `sending` rows older than the 5-minute stale
horizon), so a crashed relay's rows are reclaimed rather than stranded.

## 17. Log inspection

`task fly:logs FLY_APP=openlevel-staging`. Expect: env/role lines,
shutdown-order lines on deploys, no stack traces on the happy path, and
**no credentials, URLs with passwords, or tokens anywhere** (scrubbers +
enums guarantee it; a leak is a release-blocking defect — rotate + fix).

## 18. Smoke-testing the deployed application

Run the committed probe inventory (R14-05 — the single authoritative
suite; `scripts/smoke/inventory.ts`, executed via `task smoke` locally
or `task smoke:remote` against a deployment). It covers boot identity,
migrations, health/readiness, static delivery, the preview banner,
authentication, the full synthetic lead → contact → booking journey with
idempotency semantics, campaign lifecycle, outbox drain, reporting,
federation gates, voice/SMS/push sink-or-refuse behavior, Chatwoot
inbound verification, graceful shutdown, credential scanning, and
provider non-invocation — emitting a sanitized PASS/FAIL/NOT RUN
transcript. Manual checks that remain: all three workers registered
(agent-reply, workflow-dispatch, outbox-sweep — plus the `workflow waits
disabled` boot line and NO resume worker), one Machine, migration
evidence, and clean logs. Capture: release ID, image digest, `/health` +
`/ready` results, Machine count, migration log excerpt, and the smoke
transcript file.

## 19. Rollback

App rollback is digest-only (explicit prior digest — find it via
`task release:status FLY_APP=openlevel-staging`, never a floating tag):

```sh
task release:rollback FLY_APP=openlevel-staging FLY_CONFIG=fly.toml RELEASE_IMAGE='ghcr.io/<owner>/openlevel@sha256:…' CONFIRM_DEPLOY=yes
```

Then re-run §13–§18. Application rollback is NOT a database rollback:
staging schema stays additive so the previous image keeps working; data
is disposable — redeployment is not data recovery. Never run destructive
database rollback; if staging data is corrupt, rebuild staging (§4).

## 20. Staging limitations

Single Machine (seconds of deploy outage — never zero-downtime); no HA;
workflow SMS/email log but do not deliver; one simplified DB role; no
customer data, ever. **No paid customer is onboarded off staging.**
(All capture paths — public forms/funnels, manual add, booking,
assistant, calendars — converge on shared timeline + dispatch behavior.)

Server-enforced staging containment (not procedural): campaign email/SMS
and Chatwoot outbound route to the `outbound_sink` table (allowlisted
recipients only; everything refused without `STAGING_SINK_ALLOWLIST`);
assistant texts to non-allowlisted numbers are refused; social
publishing is refused; Square is refused; live Stripe keys are refused
(test keys only); federation tenants are allowlist-bound. Simulated
results are labeled `simulated` in API responses and UI copy.

Workflow waits are DISABLED by default (`WORKFLOW_WAITS_ENABLED`
unset): a workflow reaching a `wait` step fails loudly instead of
arming the legacy pg-boss wait machinery (Review 12 N2/N3 — the
Review-11 "durable waits" claim is withdrawn). The DBOS lead-follow-up
pilot passed 9/9 acceptance proofs on PG 18.7 (ADR-002) but is NOT
adopted: production bootstrap does not launch DBOS, and pg-boss
remains the engine for all simple background jobs.

Fixed by remediation (no longer limitations): booking/idempotency
completion is one atomic transaction (N4); release migrations enforce
env/DB identity (N1); RBAC enforces the owner role with deny-by-default;
workflow events carry stable IDs with dispatcher/agent/entry dedup;
uncertain campaign outcomes quarantine instead of blind-resending (N5).

## 21. Production readiness checklist (all 14 must pass)

1. DBOS pilot passed 9/9 acceptance proofs (ADR-002) but is NOT adopted:
   no production reachability, no bootstrap wiring, no cutover plan yet.
   pg-boss remains the engine. (Deliberate.)
2. pg-boss remains the active background execution system. (Deliberate.)
3. Workflow waits are DISABLED by default (fail loudly, never strand).
   Adopting any wait engine (DBOS cutover or repaired custom machinery)
   requires its own migration plan + staging restart-during-wait rehearsal.
   (In place as a prohibition; the capability itself is OPEN.)
4. Messaging/automation paths distinguish actual sends from log-only
   operations in code, UI, and docs. (Partially done — verify remainder.)
5. RBAC enforces operator roles: owner-only enforcement with
   deny-by-default on unknown/absent roles (Review-11 remediation,
   tested). Broader role matrix remains owner policy input. (In place
   for the only role in the codebase.)
6. Production migrations are versioned via dbmate with forward-recovery
   (baseline done; ongoing discipline + destructive-change approvals). (In place.)
7. Production region has an owner-approved geography decision. (Owner input.)
8. Production database privileges use a verified least-privilege role model
   (migrator/runtime split). (OPEN — staging simplification documented.)
9. Strategy A has written owner confirmation of no live customer state
   before any clean-start/destructive operation. (Owner input.)
10. P1 atomic enqueue, P2 worker fencing, P3 provider/wallet safety remain
    separate DBOS proof gates. (Phase 0 scope — not product staging.)
11. RLS remains deferred under V2.1 (tenancy via repos + middleware).
    (Deliberate.)
12. Single-Machine staging provides no HA; production sizing/topology is
    owner-decided and verified. (Owner decision + verification.)
13. No paid customer is onboarded until all other gates pass. (Policy.)
14. **Neon backup/PITR restore rehearsed end-to-end with dated evidence**
    (`ENVIRONMENTS.md` §7: isolated-branch restore, consistency checks,
    redeploy + secret-recovery rehearsal, recorded outputs). Documentation
    alone is not evidence. (OPEN until executed.)

## Appendix A. Review-5 reconciliation

Verified against the current checkout (labels: RESOLVED / PARTIALLY
RESOLVED / OPEN / NOT APPLICABLE / UNKNOWN):

| Finding | Label | Evidence |
|---|---|---|
| Mutations bypass shared command boundaries | RESOLVED | All routes/tools/runner mutate via `*Repo`; sole direct-SQL route (`push-tokens`) is operator-scoped + parameterized |
| Timeline + dispatch inconsistent | RESOLVED | All capture paths incl. manual add record timeline + dispatch (the manual-add gap note was stale and is withdrawn) |
| SMS/email record completion without delivery | PARTIALLY RESOLVED | Workflow actions log honestly (`logged`, never `sent`/`delivered`, test-locked); campaigns refuse without a provider and count real sends; workflow delivery itself absent by design |
| Agent operations lack persistence/side effects | RESOLVED | Contact-pinned, write-gated, repo-based tools with slot revalidation, race-safe booking, timeline + dispatch mirroring public booking |
| Waits are process-local | WITHDRAWN → CONTAINED | Review-11 durability claim withdrawn (Review 12 N2/N3); legacy waits disabled by default with loud failure; DBOS pilot passed 9/9, not adopted (ADR-002) |
| Events lack identity/dedup | RESOLVED | Stable event IDs + `singletonKey` + dispatcher/agent/entry dedup claims (Review-11 remediation) |
| RBAC/authorization weak | RESOLVED | Owner-only enforcement + deny-unknown via `require-owner` on privileged routes, tested both paths (Review-11 remediation; gate item 5 in place; broader matrix = owner policy) |
| DBOS unconnected | NOT APPLICABLE | Explicit assignment boundary: pg-boss preserved, DBOS out of scope |
| Contact creation path | RESOLVED | `upsertByMatch` + partial unique index shared by all entry points, extensively tested |

Missing inputs worked around per the checkout-authoritative hierarchy:
`prompt36.md`, `review5.md` (as specified — `adv_review5.md` is P2-scoped
and unrelated), and `OPENLEVEL_CODEBASE_MAP.md` are absent from the
checkout; reconciliation proceeded from code + the brief's inline findings.

## Appendix B. Review-11 reconciliation (remediation evidence)

All 11 P1 findings from `docs/plans/adv_review11.md` remediated locally
2026-11-19 per `docs/plans/prompt37.md` (approval: local implementation
only, no cloud mutations). Labels: RESOLVED / ACCEPTED (documented
residual, owner-visible).

| Finding | Label | Fix + regression evidence |
|---|---|---|
| FIND-01 request-path errors bypass redactor | RESOLVED | Centralized `reportError` boundary; Hono `onError`; pool/boss/process handlers; canary-throw e2e asserts scrubbed 500s |
| FIND-02 `.gitignore` contradicts docs | RESOLVED | `.env.*`/`*.pem`/`*.key` patterns ignored; `git check-ignore` contract tests |
| FIND-03 no env↔app↔DB contradiction detection | RESOLVED | `APP_ENV`×`FLY_APP_NAME`×DB-host identity contract; boot refuses mismatch; 11-case matrix test |
| FIND-04 rollback omits `-c` | RESOLVED | Rollback pins `-c` per app via unified 7-condition guard; black-box contract tests |
| FIND-05 diverged DB falsely accepted | RESOLVED | Catalog-snapshot adoption gate (advisory-locked, record-after-verify); diverged-DB regression on PG 18.7 |
| FIND-06 process-local waits | WITHDRAWN → CONTAINED | Review-11 durability claim withdrawn (Review 12 N2/N3); legacy waits disabled by default with loud failure; DBOS pilot passed 9/9, not adopted (ADR-002) |
| FIND-07 dedup open, no idempotency keys | RESOLVED | `(tenant,operation,key)`+payload-hash idempotency lib; outbox+sweeper; campaign atomic claim; event IDs + dispatcher/agent/entry dedup; concurrent-send race tests |
| FIND-08 role enforcement nonexistent | RESOLVED | Owner-only `require-owner` gate, deny unknown/absent; positive+negative tests (broader matrix = owner policy) |
| FIND-09 nontransactional booking | RESOLVED | `Database.withTransaction` + outbox + idempotency + stable event ids; fault-injection + concurrency race tests |
| FIND-10 per-env rebuild contradicts promotion | RESOLVED | CI single-build GHCR push (master-only, `GITHUB_TOKEN`); digest-only deploy/promote/rollback; equality checks |
| FIND-11 vault mixed-case bug | RESOLVED | Case-insensitive lookup, ambiguity throws; baseline exemption deleted; byte-verified |
| F2 `fly:deploy` bypasses prod confirm | RESOLVED | All deploy paths through the unified guard; prod needs exact-mapping double confirm |
| F3 region auto-default | RESOLVED | `primary_region` required by guard; runbook §8 procedure; `fly apps create` has no `--region` |
| First-match TOML regex parser | RESOLVED | Real TOML parse (`@iarna/toml`) in guard + validator |
| Lifecycle: startup leak / queue drift / worker checks | RESOLVED | `finally` cleanup + per-stage shutdown guards; `createQueue` drift warning in `boss.ts`; worker check story in `lifecycle.ts` (restart policy + DLQ alerting) |
| Secrets P2/P3s (raw errors, `?secret=`, seed guard, `cmdExec`) | RESOLVED | All error sites through `reportError`; `?secret=` REMOVED (Chatwoot native HMAC verified); seed loopback guard in-file; `cmdExec` tested |
| MVP P2/P3s (convergence, `send_text`, archived counts, persist-before-send) | RESOLVED | Assistant/calendar entry convergence; `send_text` persists queued→outcome timeline rows; reporting excludes archived; outbound persists before sending |
| CI/docs P3s (evidence ignore, fly null, `dev:health`, per-env IDs, log env tags) | RESOLVED | Run-artifact ignore rules; null-safe doctor rows; `dev:health` names port holders (tested); `RELEASE_COMMIT` baked + boot-logged + CI-asserted; `env=` on every error line |

Accepted residuals (visible, not silent): in-flight-crash run tail (stuck
run, no silent duplication); microsecond complete-then-crash wait gap;
dev-server outbox rows inert by design.

Production gates still owner-side (§21): executed PITR rehearsal with
dated evidence (item 14), least-privilege DB roles (item 8), geography +
Strategy-A confirmations (items 7, 9), production topology (item 12),
messaging/delivery remainder (item 4), observability, GitHub
scanning/push-protection enablement.

## Appendix C. Release evidence template

```
Release: <env> <date> <owner>
Commit: <sha>  Image: <digest>  Migrations: <dbmate status>
Config: <fly file> (app=<name>)  Machines: <count>
/health: <code>  /ready: <code>  Migration log: <Applied|no-op>
Smoke: <MVP transcript link>  Logs clean: <yes>
Issues: <none|list>
```

## Appendix D. Review-12 / prompt39 reconciliation (2026-11-19)

> Historical snapshot — preserved verbatim as the record of what that
> cycle claimed. Review 14 (R14-04) found several R13 labels in this
> table do not match the findings Review 13 actually filed under those
> IDs (notably R13-06, R13-13, R13-14, R13-15, R13-16, R13-17, R13-18).
> The corrected, independently traceable record is
> `docs/deployment/PRODUCTION_ROADMAP.md`; this appendix is not
> corrected in place so the history stays auditable.

Disposition of Review 12 residuals N1–N15 after the prompt39
implementation (local only; remote proofs owner-observed):

| ID | Disposition | Evidence |
|---|---|---|
| N1 release-path identity bypass | RESOLVED | `db/migrate-release.ts` runs `loadConfig()` first; refusal tests prove no-connection/no-migration/clean logs |
| N2 wait never recorded | CONTAINED | Legacy waits disabled by default (loud failure); DBOS pilot passed 9/9 as the replacement candidate (ADR-002), not adopted |
| N3 wait completes before run | CONTAINED | Same as N2 |
| N4 crash-after-commit wedge | RESOLVED | Completion commits inside the business txn; guarded release; fault-injection + real-PG replay/race tests |
| N5 provider accept-vs-record gap | RESOLVED (staging) | Staging sink + allowlist fence; `sending` markers + resume quarantine; no blind retry of uncertain outcomes |
| N6 credential-export filenames | RESOLVED | Ignore patterns + `check-ignore` tests (git + docker) |
| N7 vault separator conflation | RESOLVED | Lossy lookup documented; tenant-namespace uniqueness enforced at boot; collision tests |
| N9 federation tenant binding | RESOLVED (staging) | Server-side tenant allowlist, fail-closed in staging; production per-tenant binding is an explicit gate |
| N15 procedural-only staging | RESOLVED | Fence is code-enforced (sends, publishes, payments, federation) |
| test:pg never executed/unwired | RESOLVED | 31 tests green on PG 18.7 locally; wired into `tests.yml` (remote run owner-observed) |
| Default-parallelism failures | ROOT-CAUSED | Kernel OOM-kills workers at 16-way parallelism (dmesg-proven); serial run green → saturation, not a leak; capped-4 is the supported host setting |
| GHCR round-trip unobserved | OPEN (owner) | First master push + `promote:staging` equality proof still required |
| Owner inputs (regions, hosts, policy) | OPEN (owner) | §16 checklist; no invented defaults |

Withdrawn: the Review-11 "durable waits" claim (Review 12 contradicted
it); the "manual add fires nothing" note (code converges — the note was
stale).

## Appendix E. Review-13 / prompt41 reconciliation (2026-11-19)

Disposition of Review 13 findings after the prompt41 implementation
(local only; remote proofs owner-observed):

| ID | Disposition | Evidence |
|---|---|---|
| R13-01 voice unfenced (P1) | RESOLVED | Staging voice resolver returns the sink (allowlist-enforced); verify fail-closed; `simulated` responses; audit harness |
| R13-02 send_text live gateway | RESOLVED | Staging sinks before the rail is consulted; rail never called; `simulated` timeline + message |
| R13-03 push unfenced | RESOLVED | Staging suppresses with explicit outcome + PII-free log line; gateway untouched |
| R13-04 outbox starvation | RESOLVED | Shared recoverability predicate + covering index; stale-only locations recover; regression test |
| R13-05 payments race | DEFERRED (prod gate) | Staging-immune (live keys refused); production roadmap |
| R13-06 provider sandbox drift | DEFERRED (prod gate) | Staging-immune (fenced); production roadmap |
| R13-07 simulated counted delivered | RESOLVED | `simulated` outcome taxonomy end-to-end (engine → rows → counts → API → UI); sent counts real only |
| R13-08 doc/implementation drift | RESOLVED | §1/§16/App.A/B corrected; task-existence verified (all resolve); smoke procedure extended |
| R13-09 rotate script unguarded | RESOLVED | Loopback-only + scrubbed errors + dry-run; refusal + disposable-PG tests |
| R13-10 confirm idempotency | RESOLVED | ProposalRef/header keys; in-txn completion (DB verbs); nonce path (send_text); per-verb contracts; ref TTL; PG race proof |
| R13-11 campaign claim hold | RESOLVED | Release-on-refusal; atomic cancel + per-recipient stop; UI affordance |
| R13-12 contact identity | RESOLVED | Independent lookups; archived/identity conflicts as structured 409s; compatible-enrich only; PG race proofs |
| R13-13 payments mode proof | DEFERRED (prod gate) | Staging-immune; production roadmap |
| R13-14 campaign lifecycle spec | DEFERRED (campaign gate) | Lifecycle now specified in code + docs; production hardening roadmap |
| R13-15 orphaned continuations | DEFERRED (accepted) | Dead rows inert under the disabled engine; removal with the migration that replaces it |
| R13-16 migration re-runs | DEFERRED (accepted) | No new re-runnable side effects introduced this cycle; historical ones unchanged |
| R13-17 entitlement checks | DEFERRED (prod gate) | Out of MVP scope; production roadmap |
| R13-18 request logging | DEFERRED (prod gate) | Out of MVP scope; production roadmap |
| R13-19 settings connected-for-sink | RESOLVED | `simulated` readout flags + amber UI chips (sending + voice) |
| R13-20 accepted-vs-delivered | RESOLVED | UI/API relabeled to provider-accepted "Sent" semantics |
| R13-21 DBOS adoption | UNCHANGED | Pilot untouched (PILOT — NOT ADOPTED); cutover criteria recorded |

## Appendix E. Production preview + inference attestation (prompt43)

**Restricted preview.** The production app boots with `APP_ENV=production`
plus an explicit `RESTRICTED_PREVIEW` flag (committed in `fly.prod.toml`;
boot refuses when unset). While `true`: the central side-effect policy
refuses every external effect (SMS/email/voice/push/payments/social/
campaigns), the UI serves the exact-wording preview banner inside the
document, `/api/client-config` advertises `{preview:true}`, and boot logs
the loud `RESTRICTED PREVIEW` line. Flipping to live production is an
explicit owner edit (`false`) gated on the §21 checklist — never an
omission.

**Inference provenance.** Model egress (Anthropic) is allowed only for
tenants whose `settings.syntheticAttested` is exactly `true` — an owner
write at provisioning time, never inferred from redaction. Provisioning
checklist per environment: after creating the synthetic tenant(s),
attest them (`UPDATE locations SET settings = settings || '{"syntheticAttested":true}'`
for the synthetic location ids only); verify unattested tenants get 403
on assistant/draft paths and observable skips on agent-reply. The local
demo seed attests itself (synthetic by construction); restoring real
data anywhere never attests.
