## prompt

lock in above (writeup4.md), the goal is to establish guidelines when exactly do we use DBOS (that is, how complex is the workflow, does it really warrant DBOS to accomplish its goals, does using DBOS outweigh the accidental complexity that comes with it)


## answer

Agreed. Let's make this a **governing architectural principle for OpenLevel**, not merely a recommendation arising from the current remediation.

The default will be **do not use DBOS**. A workflow must earn DBOS through its actual execution requirements. We introduce it only when the durability, recovery, orchestration, and consistency benefits outweigh the additional programming model, operational burden, workflow-versioning constraints, and maintenance complexity.

The central question is not "Can DBOS run this?" It is:

**"Would implementing and operating this workflow correctly without DBOS require enough custom orchestration machinery that DBOS becomes the simpler, safer long-term choice?"**

Agreed. I would formalize this as **OpenLevel's DBOS Adoption Policy — Architecture Decision Record 001**.

It establishes a presumption against unnecessary DBOS adoption, a measurable way to evaluate workflow complexity, and a requirement to demonstrate that DBOS reduces overall system complexity rather than merely relocating it.

# OpenLevel Architecture Decision Record 001

## Selective Adoption of DBOS — When Durable Orchestration Is Worth Its Complexity

**Status:** Adopted architectural guideline\
**Scope:** All current and future OpenLevel features and services\
**Applies to:** Architects, developers, coding agents, reviewers, and technical decision-makers

---

## 1. Governing principle

OpenLevel does not use DBOS by default.

DBOS must earn its place in the architecture through demonstrated requirements that justify its additional programming model, operational responsibilities, and maintenance cost.

The primary decision criterion is:

**Use DBOS only when its durability, recovery, orchestration, and transaction capabilities provide greater value than the accidental complexity introduced by adopting and operating it.**

We do not introduce DBOS simply because:

- A task executes asynchronously.
- A function runs in the background.
- A process needs to be scheduled.
- A queue is involved.
- An operation has multiple steps.
- A developer wants a consistent execution framework.

Those characteristics alone do not justify a durable workflow engine.

Instead, we ask:

1. Does this operation represent a genuine business process?
2. Must it survive the lifetime of the process that initiated it?
3. Does it require durable progress across multiple execution stages?
4. Would implementing its recovery and orchestration correctly without DBOS require substantial custom infrastructure?
5. Would DBOS make the overall solution simpler, safer, and less expensive to maintain?

If the answer to these questions does not establish a meaningful advantage, use ordinary application code, PostgreSQL transactions, or an existing background-job mechanism.

---

## 2. First determine what kind of operation we are building

Before considering DBOS, classify the operation.

### Class A — Ordinary application operation

Examples:

- Retrieve a contact.
- Update a profile.
- Validate a form.
- Check appointment availability.
- Read a timeline.
- Create a contact.
- Update a business setting.

Characteristics:

- Usually completes within one request.
- Has no independent execution lifecycle.
- Requires no durable checkpointing.
- Can be protected by an ordinary database transaction.
- Does not need to resume after a process restart.

**Decision: Do not use DBOS.**

Use Hono, application services, domain commands, and PostgreSQL.

### Class B — Simple background job

Examples:

- Send one notification.
- Generate a report.
- Process one webhook.
- Synchronize one external record.
- Perform a bounded maintenance task.

Characteristics:

- Has a clear beginning and end.
- Usually consists of one independently executable operation.
- Can be safely retried using an idempotency key.
- Does not need to retain progress through several business stages.
- Does not require long-running waits or human interaction.

**Decision: Prefer pg-boss or another existing job mechanism.**

Do not introduce DBOS merely to execute a single task asynchronously.

### Class C — Multi-step background operation

Examples:

- Import contacts, validate records, and generate a report.
- Process a batch of appointments.
- Send a campaign to a bounded recipient list.
- Perform several dependent integration operations.

Characteristics:

- Has multiple operations.
- May require retries and error handling.
- Usually finishes within a bounded period.
- Can often be represented as a job with a clear execution contract.
- May not need durable progress at the level of each individual step.

**Decision: Evaluate the existing job mechanism first.**

Use DBOS when the operation has significant recovery, checkpointing, concurrency, or lifecycle requirements that are otherwise expensive to implement correctly.

Multiple steps alone are not sufficient justification.

### Class D — Durable business workflow

Examples:

- Lead follow-up spanning several days.
- Multi-stage customer onboarding.
- Campaign orchestration with delayed actions.
- Appointment reminders and confirmation sequences.
- Human approval processes.
- AI agent executions involving multiple tools.
- Customer journeys that wait for external responses.
- Long-running processes requiring cancellation, resumption, or intervention.

Characteristics:

- Progress must survive process replacement.
- Execution can span hours, days, or weeks.
- The operation contains multiple meaningful checkpoints.
- Retries must resume without repeating completed operations.
- Delayed execution is a core business requirement.
- The system must retain workflow state and execution history.
- Failure recovery is part of the product's correctness contract.

**Decision: DBOS is the preferred candidate.**

It must still pass the complexity-versus-benefit assessment before adoption.

---

## 3. The DBOS qualification gates

A workflow must satisfy the following gates before DBOS is selected.

### Gate 1 — Durable execution is a genuine requirement

The business process must require one or more of:

- Recovery after process termination.
- Durable waits.
- Resumption from a completed checkpoint.
- Progress across multiple application deployments.
- Execution spanning multiple independent stages.
- Durable waiting for an external event or human decision.

If the operation can safely restart from the beginning and has no meaningful progress to preserve, DBOS may be unnecessary.

A scheduled job is not automatically a durable workflow.

### Gate 2 — There is meaningful orchestration complexity

At least two substantial characteristics should be present:

- Multiple independently committed stages.
- Delays or long-running waits.
- External events or callbacks.
- Human approval.
- Multiple dependent external services.
- Retry behavior between stages.
- Fan-out and concurrency management.
- Compensation or recovery after partial progress.
- Cancellation, resumption, or operator intervention.
- A requirement for execution history and lifecycle visibility.

The more of these characteristics exist, the stronger the DBOS case becomes.

### Gate 3 — Failure has meaningful business consequences

Determine what happens when the operation fails midway.

Consider:

- Lost customer follow-ups.
- Duplicate messages.
- Incomplete onboarding.
- Lost campaign progress.
- Incorrect bookings.
- Repeated payments.
- Unrecoverable agent operations.
- Manual operational intervention.

If failure is harmless and the operation can simply be retried, a simpler job mechanism may be sufficient.

If failure can break a business promise or create expensive reconciliation work, durable orchestration becomes more valuable.

### Gate 4 — DBOS must reduce total complexity

Compare two complete implementations:

**Alternative A: Existing application infrastructure**

What must we implement and maintain ourselves?

- Workflow state records.
- Checkpoint management.
- Durable timers.
- Recovery and reaper mechanisms.
- Execution claims.
- Concurrency controls.
- Retry policies.
- Workflow history.
- Version compatibility.
- Failure reconciliation.

**Alternative B: DBOS**

What does DBOS provide, and what must OpenLevel still implement?

- Durable workflow execution.
- Checkpoint recovery.
- Durable sleep.
- Workflow queues.
- Transaction integration.
- Workflow versioning.
- Business-specific idempotency.
- External-provider reconciliation.
- Application authorization and business rules.
- Operational monitoring and recovery.

Choose DBOS only when Alternative B is genuinely simpler and provides stronger guarantees for the business requirement.

Do not assume a framework reduces complexity merely because it provides more features.

---

## 4. A practical workflow complexity score

Use this score as a decision aid, not as an automatic technology selector.

Score each dimension:

- **0:** Not applicable or negligible.
- **1:** Present but limited.
- **2:** Important to the business process.

| Dimension         | 0                         | 1                          | 2                                                             |
| ----------------- | ------------------------- | -------------------------- | ------------------------------------------------------------- |
| Process lifetime  | Short, request-bound      | Background duration        | Hours, days, or longer                                        |
| Execution stages  | One operation             | A few dependent operations | Multiple independently checkpointed stages                    |
| Waiting           | None                      | Short scheduled delay      | Durable long wait or external event                           |
| Recovery          | Safe full retry           | Partial retry required     | Resume from previous progress                                 |
| External effects  | None or one simple effect | One retryable integration  | Multiple consequential side effects                           |
| Coordination      | None                      | Basic concurrency          | Fan-out, rate limits, or competing workers                    |
| Human involvement | None                      | Occasional manual action   | Approvals, responses, or intervention are part of the process |

\<text weight="semibold" color="default">Interpretation\</text>

| Score | Recommendation                                                                          |
| ----- | --------------------------------------------------------------------------------------- |
| 0–4   | Ordinary application code or simple background job                                      |
| 5–7   | Evaluate existing queue and database capabilities first                                 |
| 8–10  | Strong DBOS candidate; conduct an architectural comparison                              |
| 11–14 | Very strong DBOS candidate; require explicit justification for a custom workflow engine |

Important: a high score does not automatically mandate DBOS. A workflow with a high score may have a special requirement that makes DBOS unsuitable.

Conversely, a workflow that must survive a critical multi-day wait can qualify even if its total score is relatively low.

The decisive criteria are durable business requirements and comparative complexity, not an arbitrary numerical threshold.

---

## 5. When DBOS should be the preferred choice

The following conditions strongly favor DBOS.

### A. Long-running customer journeys

A process that retains its identity and progress for days or weeks should normally be implemented as a durable workflow.

Examples:

- Lead nurturing.
- Appointment confirmation sequences.
- Customer onboarding.
- Renewal reminders.
- Multi-stage follow-up.

### B. Workflows with durable waits

Use DBOS when the process must wait for a meaningful interval and resume at the correct point after a restart.

A simple one-off scheduled notification may remain a normal queued job.

The distinction is whether waiting is merely a scheduling convenience or part of a larger business process.

### C. Multi-stage agent execution

An AI agent that invokes several tools, waits for results, evaluates decisions, and performs consequential operations is a strong candidate for durable execution.

DBOS should own orchestration, not business authorization.

### D. Human-in-the-loop processes

When a workflow waits for an operator approval, customer response, or external decision, DBOS becomes attractive because the process may remain active long after the initiating HTTP request has finished.

### E. Processes with expensive recovery

When restarting a process from the beginning would repeat expensive operations or create difficult reconciliation, checkpointed execution can provide substantial value.

---

## 6. When DBOS should explicitly be rejected

These are default rejection cases:

1. Ordinary CRUD operations.
2. Simple database transactions.
3. Authentication and authorization.
4. Simple request-response API handlers.
5. Short-running, independently retryable jobs.
6. Basic scheduled tasks with no meaningful workflow state.
7. Operations whose complete execution can safely restart without preserving checkpoints.
8. Simple notification dispatch where an existing job queue is sufficient.
9. Operations that need transactional integrity but not durable orchestration.
10. Tasks that would gain no meaningful recovery or lifecycle benefit from DBOS.

Do not wrap an ordinary database transaction in a DBOS workflow merely to standardize execution.

Do not introduce a durable workflow for a process that is already simple, reliable, and easily recoverable.

Avoid turning DBOS into a mandatory architectural dependency for every module.

---

## 7. Mandatory engineering constraints when DBOS is adopted

A decision to use DBOS creates additional obligations.

Every DBOS workflow must satisfy the following rules.

### 7.1 Deterministic workflow execution

Workflow code must invoke the same steps in the same order when replayed with the same inputs and recorded step outputs.

Nondeterministic operations, including database access, external APIs, current-time reads, and random generation, must be placed behind appropriate durable steps or transactions.

### 7.2 Idempotent side effects

DBOS does not eliminate the need for application-level idempotency.

Steps may be retried if an interruption occurs before their completion is durably recorded.

Every consequential operation must have a stable business-operation identity.

Use provider-supported idempotency keys where available.

Unknown external outcomes must be reconciled or quarantined rather than blindly repeated.

### 7.3 Transactional boundaries

Use DBOS transaction integration when the application database mutation and workflow checkpoint must commit atomically.

Do not assume that an ordinary PostgreSQL transaction automatically includes the DBOS checkpoint.

Verify the selected datasource integration and transaction semantics.

### 7.4 Workflow identity

Every workflow must have an intentional, stable identity.

The same logical operation must not accidentally produce multiple workflows because an HTTP client retried the same request.

Scope workflow identities according to tenant and business operation where appropriate.

### 7.5 Workflow versioning

Long-running workflows may survive multiple software releases.

Define how old executions remain compatible with new workflow code.

Every deployment strategy must account for pending and running workflow versions.

Do not deploy a breaking workflow change without an explicit compatibility, draining, patching, or versioning strategy.

### 7.6 Payload discipline

Workflow inputs and outputs must be serializable according to the selected DBOS serialization mode.

Persist identifiers and compact execution context, not complete customer records, passwords, database URLs, session tokens, or provider credentials.

### 7.7 Recovery and observability

Every DBOS workflow must have an operational recovery policy.

Define:

- Retry limits.
- Terminal failure handling.
- Cancellation.
- Dead-letter or failed-workflow inspection.
- Recovery ownership.
- Execution-history retention.
- Operator intervention.
- Alerting.

A durable workflow that silently becomes stuck is not a reliable business process.

### 7.8 Operational cost

Before adoption, evaluate:

- Additional database writes.
- Connection-pool requirements.
- System schema permissions.
- Database storage and retention.
- Worker topology.
- Recovery behavior.
- Workflow-versioning deployment requirements.
- Memory usage during long waits.
- Licensing implications of any desired enterprise-only capability.

Do not adopt features on the assumption that they are available in the open-source distribution. Verify the actual selected DBOS edition and version.

---

## 8. Coexistence with pg-boss

OpenLevel may temporarily operate both pg-boss and DBOS.

This is acceptable only as an intentional migration state.

Each background responsibility must have one authoritative execution owner.

Maintain a workload inventory:

| Workload                        | Execution owner            | Reason                             |
| ------------------------------- | -------------------------- | ---------------------------------- |
| Simple one-shot jobs            | pg-boss, where appropriate | Low orchestration complexity       |
| Long-running customer workflows | DBOS                       | Durable execution and recovery     |
| AI agent tool chains            | DBOS candidate             | Multi-stage resumable execution    |
| Campaign orchestration          | DBOS candidate             | Long-running, rate-limited process |
| Ordinary database mutations     | Domain layer + PostgreSQL  | No workflow engine required        |

Do not dispatch the same operation to both systems.

Do not create a second outbox or duplicate scheduling mechanism for the same workflow without a specific reason.

Review pg-boss after the initial DBOS adoption. Retire redundant infrastructure only when the workload inventory demonstrates that it is no longer needed.

The target is the simplest reliable execution architecture, not permanent coexistence between two overlapping systems.

---

## 9. DBOS adoption decision template

Every proposal to introduce DBOS must answer the following questions before implementation.

**A. Business requirement**

What customer or business process is being implemented?

What business promise must this process fulfill?

**B. Execution characteristics**

How many distinct stages exist?

How long can the process remain active?

Does it wait for time, external events, or humans?

Does it need checkpoints?

Does it need to resume after restarts or deployments?

**C. Failure analysis**

What happens if the application crashes at every important transition?

Can the process restart from the beginning?

Can it duplicate a business operation?

Can it lose committed progress?

What would the operator have to do to recover it?

**D. Existing alternatives**

Can ordinary PostgreSQL transactions solve the problem?

Can pg-boss solve it with a simple idempotent job?

What additional custom state machine, reaper, recovery, or synchronization logic would be required without DBOS?

**E. DBOS benefits**

Which specific DBOS capabilities solve the demonstrated problems?

- Durable checkpoints.
- Durable sleep.
- Workflow recovery.
- Queues.
- Workflow identity and deduplication.
- Transaction integration.
- Workflow history.
- Versioning.

Do not list capabilities that the proposed workflow does not need.

**F. Accidental complexity assessment**

What new complexity does DBOS introduce?

What existing custom complexity will it eliminate?

What operational procedures become necessary?

Does the net complexity decrease?

**G. Decision**

Choose one:

- REJECT DBOS — simpler existing approach is sufficient.
- DEFER DBOS — future requirements may justify adoption.
- PILOT DBOS — implement a limited proof with measurable acceptance criteria.
- ADOPT DBOS — demonstrated requirements and proof justify the framework.
- RETIRE DBOS — the existing workflow no longer warrants durable orchestration.

No implementation prompt should silently move from consideration to adoption without an explicit decision.

---

## 10. Final architectural rule

The guiding principle for OpenLevel is:

**Use the simplest execution mechanism that reliably satisfies the business requirement.**

Ordinary operations belong in ordinary application code.

Atomic data changes belong in PostgreSQL transactions.

Simple background work belongs in an existing queue.

Durable, multi-stage business processes belong in DBOS when its execution guarantees materially reduce the amount of custom recovery and orchestration machinery OpenLevel must build and maintain.

The framework must earn its complexity.

We do not want DBOS everywhere.

We want DBOS exactly where not having it would make the system unnecessarily difficult to build, prove, operate, and trust.

## **The decision process in one picture**

**New business operation**

Classify its execution and failure requirements

**Does it need durable progress across process lifetimes?**

No

**Simple operation**

Hono + domain services + PostgreSQL, or pg-boss for a one-shot job.

Yes

**Durable candidate**

Assess stages, waits, retries, side effects, and recovery needs.

**Would DBOS eliminate more custom complexity than it introduces?**

**No**

Keep the simpler existing implementation.

Yes

**DBOS pilot**

Prove recovery, idempotency, versioning, and operational cost.

## **One important technical qualification**

The policy incorporates several guarantees from DBOS's current documentation:

- Workflow replay requires deterministic control flow; nondeterministic operations belong in steps.&#x20;

  [image](https://www.google.com/s2/favicons?domain=https://docs.dbos.dev\&sz=32)

  DBOS Docs+1

- Durable sleep persists wake-up time, while suspending sleeping workflows to avoid retaining them in memory is an Enterprise capability.&#x20;

  [image](https://www.google.com/s2/favicons?domain=https://docs.dbos.dev\&sz=32)

  DBOS Docs+1

- Single-node recovery occurs at startup; distributed recovery needs additional coordination or Conductor.&#x20;

  [image](https://www.google.com/s2/favicons?domain=https://docs.dbos.dev\&sz=32)

  DBOS Docs+1

- Application versioning affects which existing workflows can be recovered by the running version.&#x20;

  [image](https://www.google.com/s2/favicons?domain=https://docs.dbos.dev\&sz=32)

  DBOS Docs+1



These are exactly the kinds of additional costs the adoption policy requires us to weigh.

**This is now the standing architectural rule I will apply to OpenLevel design reviews and coding-agent prompts: DBOS is justified by durable business-process complexity, not by the mere presence of asynchronous work.**
