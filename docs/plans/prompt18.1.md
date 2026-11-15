I reviewed `plan_prompt18.md` against the merged repository, the existing P2 implementation, P3's provider-safety code, and the controlling V2.1 architecture.

**My verdict:**

GO WITH CHANGES

The plan is well structured and correctly keeps cloud deployment, production access, commits, and pushes outside the assignment. I would not send it to the coding agent completely unchanged, though. There are several important proof gaps.

## **Five changes I consider essential**

### **1\. Clearly distinguish infrastructure proof from production readiness**

The current repository does not yet contain the production DBOS worker or DBOS-enabled web entrypoint. The existing application still runs its pg-boss architecture.

The referenced `Dockerfile.p2staging` and `dist/boot.js` are also absent.

This means P2 can demonstrate Fly/DBOS execution, deployment, and recovery mechanics using an isolated probe application. It cannot honestly demonstrate that the actual OpenLevel product has completed its DBOS migration.

The final verdict must distinguish:

* P2 infrastructure proof passed.  
* Actual OpenLevel application integration remains pending.  
* Production deployment readiness remains unproven.

Do not manufacture a web process that falsely represents the future production web architecture.

### **2\. Separate the two database connection responsibilities**

There is an existing inconsistency:

* `boot-worker.mjs` requires `P2_SYSTEM_DATABASE_URL`.  
* `probe-workflows.ts` reads `P2_DATABASE_URL` and supplies it to `DBOS.setConfig({ systemDatabaseUrl: url })` while also using it for application queries.

These are different responsibilities and should not be hidden behind one ambiguous connection variable.

Define explicit configuration:

| Variable | Responsibility |
| ----- | ----- |
| `P2_SYSTEM_DATABASE_URL` | DBOS system database |
| `P2_APPLICATION_DATABASE_URL` | Probe data, heartbeat and application tables |

The values may connect to the same Neon database, but their roles, permissions, and connection policies must be independently understood.

The setup must also respect the architecture's `app` and `dbos` schema separation. Do not casually create the proof tables in `public`.

Relevant files: [boot-worker.mjs](https://github.com/PithomLabs/openlevel/blob/master/phase0/p2/boot-worker.mjs?utm_source=chatgpt.com) and [probe-workflows.ts](https://github.com/PithomLabs/openlevel/blob/master/phase0/p2/probe-workflows.ts?utm_source=chatgpt.com).

### **3\. Make the fake provider genuinely independent of worker state**

This is particularly important.

P3 already has a sound conceptual foundation: it records a durable provider-side effect independently of the application's attempt state. Its existing fake provider uses a JSONL log, however, which is not an appropriate persistence mechanism for a Fly Machine replacement test.

See [P3 fake-provider.ts](https://github.com/PithomLabs/openlevel/blob/master/phase0/p3/fake-provider.ts?utm_source=chatgpt.com) and [P3 wallet.ts](https://github.com/PithomLabs/openlevel/blob/master/phase0/p3/wallet.ts?utm_source=chatgpt.com).

The new staging simulation should have two distinct durable records:

1. Application-side attempt state.  
2. Provider-side accepted-operation ledger.

The simulated provider must commit its acceptance independently before returning a response. Then deliberately terminate the worker before it can persist the successful outcome.

After recovery, prove that the system does not dispatch the same operation again.

**The invariant is one business operation, one accepted provider operation, regardless of worker crashes or lost responses.**

Writing both records inside the same transaction would invalidate this experiment.

### **4\. Do not confuse Fly rolling deployment with executor fencing**

This is the most consequential correction to the plan.

Fly describes rolling deployment as replacing Machines one at a time. However, its November 5, 2026 engineering update specifically discusses how rolling deployments do not cordon Machines before updating them. Consequently, `max_unavailable = 1` is not proof that two DBOS executors cannot overlap.

Fly+1

We must preserve the V2.1 safety requirement:

**The old worker must be demonstrably stopped before the replacement worker is allowed to execute.**

The test must establish this using actual Machine state transitions and independently recorded executor boot identities.

A heartbeat table containing only one repeatedly overwritten row is insufficient. Store separate worker boot generations, including:

* Fly Machine ID.  
* Unique boot ID.  
* Executor identity.  
* Started timestamp.  
* Last heartbeat.  
* Draining/stopped state.

Otherwise, a replacement can overwrite the old worker's record and conceal an overlap.

### **5\. Distinguish health monitoring from automatic recovery**

Another subtle but important detail: Fly health checks do not themselves restart or stop Machines. Top-level checks provide monitoring, while service checks influence traffic routing. Restart policies respond to process exits.

Fly Docs+1

Therefore, the implementation must not claim that a stale heartbeat automatically recovers a worker.

It must establish which mechanism actually handles a failed or unresponsive executor:

* Process failure and Fly restart policy.  
* Worker-specific readiness and heartbeat.  
* Detection and alerting when a process remains alive but is no longer functioning.  
* Controlled shutdown or operator intervention where automatic recovery is not established.

These are different failure modes.

## **Addendum for the coding agent**

I would append this to the existing implementation assignment rather than rewrite the entire plan.

# **P2 IMPLEMENTATION ADDENDUM — CLOSE THE REMAINING PROOF GAPS**

This addendum supplements `plan_prompt18.md`. It does not replace its objectives or authorization boundaries.

Do not restart the architecture review.

### **1\. Explicitly classify the P2 result**

The current OpenLevel application does not yet contain the production-intended DBOS worker and DBOSClient web integration.

The P2 application is therefore an isolated infrastructure proof harness.

Its successful execution may establish Fly/DBOS deployment and recovery behavior, but MUST NOT be represented as proof that the actual OpenLevel application has completed its DBOS integration or is production-ready.

If a minimal web probe is needed, implement it as an explicitly identified probe process. Prove it uses the client-only DBOS API and does not initialize an executor. Do not pretend it is the existing product web application.

### **2\. Separate database connection roles**

Remove ambiguity between DBOS and application database connections.

Use:

* `P2_SYSTEM_DATABASE_URL`  
* `P2_APPLICATION_DATABASE_URL`

The boot wrapper, worker, setup process, probe runner, and acceptance documentation must use these consistently.

Validate the intended direct-versus-pooled behavior separately for each connection.

Use the existing architecture's `app` and `dbos` schemas. Do not introduce an unqualified public-schema proof database.

### **3\. Preserve independent provider-side durability**

The fake provider must simulate an external operation whose acceptance survives worker termination.

The provider acceptance ledger and application attempt records MUST NOT be committed in the same transaction.

Required sequence:

1. Persist application attempt as dispatching.  
2. Commit the attempt.  
3. Simulated provider accepts the operation.  
4. Commit provider acceptance independently.  
5. Deliberately terminate the worker before it receives or persists the response.  
6. Restart the worker.  
7. Inspect the existing attempt and provider acceptance evidence.  
8. Refuse blind redispatch and preserve the uncertain outcome.

Assert exactly one provider acceptance for the stable operation ID across the original execution and recovery.

Reuse P3 decision logic where technically appropriate. Do not reuse its JSONL provider log as the Fly staging persistence mechanism.

### **4\. Detect overlapping executor generations**

Do not overwrite a single heartbeat row.

Persist independently identifiable worker boot generations, including:

* Machine ID.  
* Boot ID.  
* Executor ID.  
* Started timestamp.  
* Last heartbeat timestamp.  
* Readiness and draining state.  
* Observed shutdown timestamp, when available.

Use database-generated timestamps for ordering.

Acceptance requires evidence that no two worker generations were simultaneously active as executors.

A fixed `DBOS__VMID=worker-1` is necessary but is not independently sufficient to prove mutual exclusion.

### **5\. Preserve the strict deployment safety invariant**

Do not treat `max_unavailable = 1` as an executor-fencing mechanism.

Verify current Fly deployment behavior and test the actual replacement path.

Preserve V2.1's explicit stop-then-start safety procedure unless the staging experiment demonstrates an equally strong automated alternative.

If actual deployment behavior cannot establish the required no-overlap invariant, return BLOCKED rather than introducing an unproven assumption or silently adding a custom lock.

### **6\. Separate liveness, readiness, and restart**

Document and test separately:

* Worker process liveness.  
* DBOS executor readiness.  
* Database connectivity.  
* Heartbeat freshness.  
* Fly Machine restart behavior.

A stale heartbeat is not proof that Fly automatically restarted the Machine.

Select an appropriate failure-detection and restart mechanism, then prove its behavior without relying on the web process's health endpoint.

### **7\. Explicitly enumerate T1**

Define all T1 negative cases and the positive startup case before writing the tests.

At minimum, cover:

* Missing ROLE.  
* Incorrect ROLE.  
* Missing system database URL.  
* Unreachable system database.  
* Conflicting DBOS VMID.  
* Missing worker entrypoint.  
* Valid worker initialization.

Assert that every rejected startup produces a nonzero exit before executor initialization. The valid case must demonstrate actual initialization, not a successful dry-run.

### **8\. Git discipline**

Because PR \#1 is already merged, perform new work on a dedicated branch based on the merged `master`, preferably:

`phase0/p2-staging-readiness`

Preserve the existing `phase0/automated-testing` history and all untracked user files.

Do not commit or push. The owner will publish the changes manually.

### **9\. Final verdict**

Use exactly one of:

`READY FOR OWNER AUTHORIZATION`

`FIX REQUIRED`

`BLOCKED`

A readiness verdict does not mean P2 passed. All actual Fly/Neon acceptance results remain BLOCKED until the separately authorized staging execution.

Guiding principle:

Fix the cause, strengthen the system, and prove the solution—not merely silence the error.

## **Final recommendation**

I would retain the original plan and make these amendments before implementation.

The most important issue is that **we must prove actual executor exclusivity and recovery, not merely successful worker startup**.

Once the P2 infrastructure test genuinely passes, I recommend closing the infrastructure work and moving to Phase 1A: agency, membership, subscriptions, entitlements, and the AI wallet. That gets us closer to a sellable product rather than another cycle of infrastructure engineering.

The eventual target remains the roofing contractor workflow: lead capture → rapid response → qualification → booked inspection → follow-up

