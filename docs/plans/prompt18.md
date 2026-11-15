With PR \#1 merged, the next high-impact task is **Phase 0 P2: prove Fly/Neon worker deployment, fencing, and recovery in staging.**

This is the remaining operational proof before moving into Phase 1A, the agency and billing foundation.

The repository's evidence matrix confirms that P2's configuration and probe preparation have passed static checks, but the actual staging tests (T1–T5) remain blocked pending staging authorization. [Current evidence matrix](https://github.com/PithomLabs/openlevel/blob/master/phase0/EVIDENCE_MATRIX.md?utm_source=chatgpt.com).

I also found something important: the existing P2 harness is not yet sufficient to prove its intended behavior. Its worker boot wrapper can exit successfully without launching a worker, and its simulated provider workflow does not yet establish that an irreversible operation cannot be repeated after a crash. The prompt below makes fixing those underlying gaps the first priority.

## **Agent prompt — P2 staging readiness and acceptance**

# **Mission: OpenLevel Phase 0 — P2 Fly/Neon Staging Acceptance Readiness**

You are the senior infrastructure and reliability engineer responsible for completing the remaining Phase 0 deployment proof for OpenLevel.

Repository:

`/Users/sherwin/Documents/openlevel/openlevel`

Controlling branch: `master`

PR \#1 has been merged. Its merge commit is:

`35254781f3753f61cda568bac4665551c589d047`

The purpose of this assignment is to make the existing P2 staging proof harness genuinely executable, safe, and capable of producing credible evidence.

**Do not restart the architecture review. Do not redesign the infrastructure. Do not expand product scope.**

The controlling architecture is:

`docs/architecture/OPENLEVEL_DBOS_FLY_NEON_ARCHITECTURE_V2_1.md`

Additional execution guidance:

* `docs/plans/plan6.2.md`  
* `phase0/AUTOMATED_TESTING_PLAN.md`  
* `phase0/EVIDENCE_MATRIX.md`  
* `phase0/p2/`

## **1\. Strategic objective**

P1 atomic enqueue, P3 wallet/provider safety, and database backpressure have passed their relevant native PostgreSQL and CI gates.

P2 remains unproven in the actual deployment environment.

We must establish that the production-intended architecture behaves correctly under:

1. Fly worker deployment and Machine replacement.  
2. Single-executor identity and fencing.  
3. Graceful shutdown and forced termination.  
4. DBOS durable workflow recovery.  
5. Uncertain provider-operation recovery without blind retries.  
6. Neon direct/system-database and application-connection behavior.  
7. Worker availability and heartbeat monitoring.

The target remains:

* One Fly application with separate web and worker process groups.  
* One worker Machine initially.  
* `DBOS__VMID=worker-1`, assigned exclusively by the worker boot path.  
* Neon PostgreSQL with separate `app` and `dbos` schemas.  
* Hono web process using `DBOSClient`, never the DBOS executor.  
* DBOS durability and transactional enqueue.  
* No pg-boss cutover in this assignment.

The goal is not merely to produce a deployment that starts. It is to prove that the system remains correct during failure and recovery.

## **2\. Mandatory first step: establish the actual repository state**

Before modifying anything, inspect:

```
git status --short
git branch --show-current
git log -8 --oneline --decorate
git rev-parse HEAD
git branch -vv
```

Confirm that the merged PR \#1 commit is present in the current history.

If the working tree contains unrelated changes, preserve them. Do not reset, stash, overwrite, or discard user work.

Inspect the actual current implementation, including:

```
phase0/p2/boot-worker.mjs
phase0/p2/fly.staging.toml
phase0/p2/probe-workflows.ts
phase0/p2/proof-checklist.md
phase0/p2/schema.sql

phase0/setup-db.ts
phase0/db-guard.ts
phase0/p3/
phase0/p1/

docs/architecture/OPENLEVEL_DBOS_FLY_NEON_ARCHITECTURE_V2_1.md
docs/plans/plan6.2.md
phase0/EVIDENCE_MATRIX.md
```

Also locate and inspect:

* The actual production-intended DBOS worker entrypoint.  
* The web process entrypoint.  
* Dockerfile referenced by the staging Fly configuration.  
* Existing worker shutdown and signal-handling implementation.  
* DBOS configuration and system-database connection handling.  
* Existing provider-attempt and uncertain-outcome implementation.  
* Existing worker heartbeat implementation, if any.

Do not rely on comments or planning documents when the actual code can be inspected.

## **3\. Workstream A — adversarial review of the existing P2 harness**

Audit the existing P2 implementation before extending it.

There are specific issues that must be investigated.

### **A. Worker boot must fail closed**

The current `boot-worker.mjs` has a path where a missing `P2_WORKER_ENTRY` causes it to log a dry-run message and exit successfully.

That is dangerous if the same path can be reached during an actual staging deployment.

Determine whether Fly can report a worker process as successfully started even though no DBOS executor was initialized.

Correct the underlying problem.

Requirements:

* An actual staging worker must never exit successfully without initializing its intended DBOS worker entrypoint.  
* A missing worker entrypoint must fail closed.  
* An explicitly declared local dry-run mode may exist for unit testing, but it must be impossible to mistake that mode for a successful staging worker.  
* `DBOS__VMID` must be assigned only by the worker boot path.  
* Conflicting identity must prevent startup.  
* Database connectivity and required configuration must be verified before worker initialization.  
* The wrapper must not mask initialization failures.

Trace the complete boot sequence. Do not patch only the missing environment variable.

### **B. Prove that the probe workflows actually execute**

Inspect `probe-workflows.ts`.

Determine whether the current implementation:

* Registers the workflows correctly.  
* Starts the DBOS executor correctly.  
* Provides a real way to enqueue each probe.  
* Persists enough information to reconstruct execution and recovery.  
* Drains and closes resources correctly on SIGTERM.  
* Can be invoked safely without exposing an unauthenticated public endpoint.

A function being registered is not proof that a workflow has been executed.

Create a small, controlled mechanism to enqueue and inspect the probe workflows. Prefer an operator-invoked staging command or another restricted mechanism over a public route.

### **C. Provider-operation simulation must prove the real safety property**

The existing 15-second delay in `providerWorkflow` is not an external side-effect proof.

Likewise, writing an `attempt-uncertain` marker and returning does not prove that an ambiguous provider operation will not be repeated.

Use the existing P3 provider-attempt implementation and fake-provider infrastructure wherever possible.

Do not build a second provider-safety architecture.

The staging probe must model:

1. Stable operation identity.  
2. Durable attempt identity.  
3. Persisted dispatch state.  
4. A simulated provider acceptance that survives worker termination.  
5. An intentionally uncertain outcome.  
6. Recovery that inspects the persisted attempt before deciding whether dispatch is allowed.

Use a controllable fake provider or durable test ledger. Never issue real customer charges, messages, calls, or other billable provider operations.

The key invariant:

**One business operation must never produce a second provider dispatch merely because the worker restarted or lost the response to its first dispatch.**

### **D. Heartbeat must represent actual worker readiness**

The staging configuration refers to a worker heartbeat, but verify that a functioning implementation exists.

A heartbeat must identify at least:

* Executor identity.  
* Fly Machine identity.  
* Process identity or boot instance.  
* Observation timestamp.  
* Worker readiness state.  
* Database connectivity state.

It must not report healthy merely because the Node process exists.

Distinguish web HTTP health from actual worker readiness.

Implement only the smallest useful heartbeat mechanism needed for this proof. Do not build an admin dashboard or a generalized monitoring platform.

### **E. Staging database schema**

Inspect `phase0/p2/schema.sql` and trace whether the actual setup path applies it.

The schema must be:

* Idempotent.  
* Restricted to the staging proof.  
* Safe to apply without destroying existing data.  
* Sufficient for workflow, heartbeat, and provider-attempt evidence.

Do not assume the comment in the SQL file proves that the schema is actually installed.

## **4\. Workstream B — reconcile Fly deployment behavior**

Inspect:

`phase0/p2/fly.staging.toml`

And compare it against:

* V2.1 §5 and §10.  
* The additional P2 deployment requirements in `docs/plans/plan6.2.md`.  
* Current official Fly.io documentation.

There is an important configuration question to settle.

V2.1 describes the single-worker deployment as an operator-verified stop-then-start replacement, noting that `max_unavailable` has limited meaning with a worker count of one. The later plan6.2 addendum calls for an automated rolling-deployment test with `max_unavailable = 1`.

Do not blindly choose one statement.

Verify the current Fly platform semantics and define the exact observable behavior that guarantees no overlapping executors.

The staging configuration must establish:

* Separate web and worker process groups.  
* Worker-only executor identity.  
* Exactly one worker Machine.  
* Bounded graceful shutdown.  
* Correct worker restart policy.  
* No uncontrolled restart loop on intentional deployment shutdown.  
* Correct deployment and rollback behavior.  
* No app-wide `DBOS__VMID`.  
* Appropriate worker resource allocation.

Keep the single-worker architecture.

Do not introduce an advisory-lock coordinator, custom distributed fencing service, or another orchestrator unless actual evidence demonstrates that Fly and DBOS cannot provide the required safety.

### **Region selection**

The current staging configuration has `iad` as a placeholder.

Do not turn that placeholder into a commercial or production-region decision.

Determine the minimum region information needed for a disposable staging proof. Clearly separate:

* Temporary staging-region selection.  
* Final production-region selection, which depends on the first paying customer and the agreed commercial geography.

## **5\. Workstream C — build an executable P2 acceptance procedure**

The goal is a deterministic, repeatable staging test—not a checklist that depends on an operator interpreting ambiguous logs.

Implement the smallest practical command or scripts needed to execute and capture the following tests.

### **T1. Identity and startup safety**

Prove:

* Missing `ROLE` prevents startup.  
* Wrong `ROLE` prevents startup.  
* Missing system database URL prevents startup.  
* Conflicting `DBOS__VMID` prevents startup.  
* Missing worker entrypoint prevents staging startup.  
* A real worker initializes with exactly `worker-1`.  
* The web process never initializes a DBOS executor.

Record the process identity and executor identity.

### **T2. Actual Fly rolling deployment**

Execute a deployment while the following workflows are active:

1. A normal durable workflow.  
2. A workflow inside the simulated provider operation.  
3. A workflow with an already persisted uncertain attempt.

Capture the old and replacement Machine states and timestamps.

Prove:

* The old executor stops before its replacement begins executing.  
* No two active executors use `worker-1` simultaneously.  
* The replacement initializes and recovers pending workflows.  
* A completed durable step is not executed again merely because of restart.  
* The simulated provider operation is not blindly dispatched again.  
* The uncertain operation remains quarantined.

A healthy web endpoint is not proof that the replacement worker is healthy.

### **T3. Forced Machine replacement**

Perform forced replacement during:

* A normal durable step.  
* A simulated provider operation.

Prove:

* DBOS recovers the pending workflow correctly.  
* The existing operation identity is preserved.  
* The provider attempt is inspected before any new dispatch.  
* No duplicate accepted operation occurs.  
* Worker heartbeat loss and recovery are observable.

A clean SIGTERM restart alone does not satisfy this test.

### **T4. Graceful shutdown and restart behavior**

Test:

* SIGTERM.  
* Stop-dequeue behavior.  
* Bounded in-flight workflow handling.  
* Pool closure.  
* Exit within the configured 120-second timeout.  
* Worker crash and restart policy.  
* Intentional deployment shutdown without restart loops.

Record actual restart timing rather than inventing retry intervals.

### **T5. Heartbeat and database connectivity**

Prove:

* Heartbeat is emitted only after meaningful worker initialization.  
* Heartbeat contains the correct executor and Machine identity.  
* A stopped worker produces a stale heartbeat.  
* Database unavailability marks the worker unhealthy.  
* The web process can remain independently healthy without falsely asserting that the worker is ready.  
* Recovery updates the heartbeat correctly.

### **T6. Neon connection behavior**

Validate the real staging connection paths.

Specifically distinguish:

* DBOS system database connection.  
* Application data connection.  
* Direct connection.  
* Pooled connection, where applicable.

Use the architecture's intended pool sizing and connection configuration.

Determine whether the configured Neon endpoint is compatible with DBOS workflow execution, transactional enqueue, recovery, and worker lifecycle.

Do not assume PostgreSQL wire compatibility establishes operational compatibility.

Record actual connection observations, pool settings, errors, and recovery behavior.

Do not change the database provider or add a universal database abstraction during this assignment.

## **6\. Execution and security boundaries**

**Cloud staging operations are NOT authorized by this assignment.**

You may inspect and modify repository code and run safe database-independent tests.

You must stop before:

* Creating or modifying Fly applications or Machines.  
* Running `fly deploy`.  
* Scaling, restarting, killing, or replacing remote Machines.  
* Setting, changing, listing, or exposing remote secrets.  
* Creating or modifying Neon databases, branches, schemas, or roles.  
* Running migrations against any remote database.  
* Triggering remote workflow execution.  
* Contacting or modifying production resources.

Do not access `.env` or print secrets.

Do not ask the owner to paste credentials into chat.

Do not install Docker or ask the owner to install Docker. The owner's Mac does not have Docker; Docker-backed tests belong in GitHub Actions.

Do not use production resources.

All external provider behavior must use a controlled fake provider.

The next cloud execution requires a separate explicit owner authorization after this readiness assignment is complete.

## **7\. Testing requirements**

Run the appropriate safe checks:

```
npm run typecheck
npx tsc -p phase0/tsconfig.json --noEmit
npm run test:phase0:unit
```

Add focused unit tests for all new fail-closed behavior, configuration validation, heartbeat classification, operation recovery, and probe-runner behavior.

Use GitHub Actions for container-backed tests if needed.

Do not claim any staging behavior has passed based on local tests or static inspection.

Classify all evidence accurately:

* Static inspection.  
* Unit-test proof.  
* Native PostgreSQL proof.  
* GitHub Actions integration proof.  
* Actual Fly/Neon staging proof.

Only the last category can satisfy P2-T1 through P2-T6.

Do not alter the known `vault.test.ts` baseline merely to improve the test count.

## **8\. Scope restrictions**

Do not:

* Reopen V2.1 architecture.  
* Implement Phase 1A agency and billing features yet.  
* Introduce RLS.  
* Replace pg-boss.  
* Add multi-worker execution.  
* Add a custom distributed lock or fencing service without demonstrated necessity.  
* Build a new monitoring platform.  
* Implement unrelated product functionality.  
* Expand into universal PostgreSQL portability implementation.  
* Rewrite existing documents for cosmetic reasons.

Preserve the longer-term requirement for Neon, CockroachDB, Supabase, Tiger Data, PlanetScale PostgreSQL, and standard PostgreSQL. Do not let that future requirement derail the P2 acceptance work.

## **9\. Required deliverables**

Produce:

### **A. P2 adversarial readiness report**

For every test T1–T6, provide:

* Required invariant.  
* Existing implementation.  
* Identified defect or missing proof.  
* Root cause.  
* Correction made.  
* Regression test.  
* Evidence classification.  
* Remaining staging requirement.

### **B. Executable staging acceptance package**

Provide the exact commands and sequence the owner will run after authorization.

Include:

* Required Fly staging application configuration.  
* Required Neon staging connection configuration.  
* Required secret names, never their values.  
* Required Fly process count and worker identity.  
* Safe schema initialization.  
* Workflow probe execution.  
* Deployment and forced-replacement procedure.  
* Evidence collection and reconciliation.  
* Teardown procedure.

### **C. Evidence updates**

Update `phase0/EVIDENCE_MATRIX.md` only where the new work genuinely changes a result.

Static preparation may be marked PASS when proven.

All actual Fly/Neon staging tests must remain BLOCKED until executed and observed.

Do not manufacture PASS results.

### **D. Git report**

Report:

* Branch and HEAD.  
* Changed files.  
* Test commands and actual results.  
* Commit status.  
* Any uncommitted work.

Do not commit or push. The owner handles Git publication manually.

### **E. Final verdict**

Choose exactly one:

**READY FOR OWNER AUTHORIZATION**

The code-side harness is executable, fail-closed, and prepared for controlled Fly/Neon staging acceptance. No cloud operations have been performed.

**FIX REQUIRED**

A correctness, safety, or executable-proof defect remains.

**BLOCKED**

A dependency or architectural uncertainty prevents a trustworthy readiness determination.

## **10\. Stopping rule and next roadmap stage**

Do not continue expanding Phase 0 after the P2 staging requirements pass.

Once P1, P2, P3, and backpressure are genuinely proven, recommend moving to:

**Phase 1A — Agency and Billing Foundation**

That work should implement the minimum commercially necessary agency, membership, subscription, entitlement, wallet, and metering foundation.

The larger objective remains a commercially viable SaaS for residential roofing contractors—not an endless infrastructure project.

Our engineering decisions must continually serve the path:

Reliable infrastructure → working lead-to-booked-inspection journey → paid pilot customers → validated willingness to pay.

**Guiding principle: Fix the cause, strengthen the system, and prove the solution—not merely silence the error.**

## **What happens after this task**

1. **Complete P2 readiness.**  
   The coding agent fixes the proof harness and returns `READY FOR OWNER AUTHORIZATION`.  
2. **Authorize actual staging execution.**  
   Only then do we deploy the isolated Fly/Neon staging environment and run T1–T6.  
3. **Move to Phase 1A.**  
   Once P2 passes, stop investing in infrastructure proof and build the agency/billing foundation.  
4. **Return to the business outcome.**  
   Complete the roofing lead-to-booked-inspection journey and pursue paid pilots.

The important thing is to avoid confusing a successful deployment with a proven deployment. P2 is where we establish that OpenLevel can recover safely when the infrastructure underneath it fails.

