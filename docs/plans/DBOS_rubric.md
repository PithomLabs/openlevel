# **DBOS adoption rubric: business value, rule integrity, and net complexity**

## **1. My assessment**

The existing `DBOS.md` establishes the right architectural presumption: **DBOS is not the default, and a workflow must earn its complexity.** Its A–D classification, qualification gates, engineering constraints, and adoption decision template are worth retaining.&#x20;

DBOS.md

DBOS.md



However, its seven-dimensional score primarily measures execution mechanics: lifetime, stages, waiting, recovery, external effects, coordination, and human involvement. It does not adequately measure the business value of the process, the importance of its business rules, or the cost of preserving those rules correctly over time.&#x20;

DBOS.md



The three reviews identify complementary parts of the solution:

- **Claude's review** contributes the distinction between separable and entangled business rules, the importance of policy re-evaluation, and the need to compare DBOS against a simpler PostgreSQL alternative—not merely the current implementation.&#x20;

  DBOS_review\.md

  DBOS_review\.md

- **DeepSeek's review** contributes the distinction between essential business complexity and accidental implementation complexity. It correctly argues that a high-value process does not automatically justify DBOS.&#x20;

  DBOS_review\.md

- **Z's review** contributes the most useful overall structure: business value, rule-web fit, DBOS adoption cost, and the cost of not adopting DBOS. Its treatment of operational visibility, policy volatility, and residual custom infrastructure is particularly valuable.&#x20;

  DBOS_review\.md



I would consolidate these into a **four-lens comparative rubric, governed by hard qualification gates and explicit readiness requirements**.

I would not adopt any of the three proposed numerical threshold systems as written. Their scores are useful for structured evaluation, but thresholds such as `V ≥ 18` or `D ≥ 4` have not been calibrated against enough real workloads. They give an appearance of mathematical precision that the underlying judgments do not yet support.

The more important improvement is to stop treating DBOS suitability as one number.

## **2. The central distinction: essential business complexity versus accidental complexity**

This is the conceptual foundation of the revised policy.

### **Essential business complexity**

Essential complexity exists because the business process itself is complicated.

Consider a customer-engagement process:

1. A lead submits an inquiry.
2. The system evaluates eligibility.
3. The system checks consent and communication preferences.
4. A follow-up is scheduled.
5. The customer may respond, unsubscribe, or become ineligible.
6. The system re-evaluates the applicable rules.
7. The system decides whether another interaction is appropriate.
8. An operator may intervene.
9. The process eventually completes, expires, or is cancelled.

The complexity here is not artificial. It represents the business's actual operating policy.

The process has economic value because it consistently applies those rules, respects customer preferences, prevents inappropriate actions, and preserves the customer relationship.

Removing that complexity would damage the business process.

### **Accidental complexity**

Accidental complexity exists because the implementation must somehow execute and preserve the business process.

Without a workflow engine, developers may have to build:

- Workflow state records.
- Continuation records.
- Durable timers.
- Worker claims and leases.
- Retry mechanisms.
- Stale-work recovery.
- Reapers.
- Execution history.
- Workflow version compatibility.
- Cancellation and resumption.
- Operator recovery tools.

Some of these mechanisms may be necessary. Others may be avoidable.

DBOS is valuable when it removes enough of this accidental complexity while preserving the essential business process.

But there is an important qualification:

**DBOS does not automatically capture the business rules. It provides an execution and durability model through which the application can implement a business process.**

The rules, their ownership, their interpretation, and their relationship to customer data remain application responsibilities.

That distinction should become explicit in the architecture.

## **3. The proposed four-lens rubric**

# **Four lenses, one architectural decision**

Lens 1

**Business value at stake (BV)**

What is the value of correctly executing and capturing this business process?

Lens 2

**Rule-web and execution fit (RF)**

Can DBOS represent the process's lifecycle without distorting its business rules?

Lens 3

**DBOS adoption cost (AC)**

What complexity does DBOS introduce for this workload, team, and operating environment?

Lens 4

**Non-DBOS counterfactual cost (NC)**

What would it genuinely cost to implement and operate the same correct process without DBOS?

## **Net complexity difference**

\\[ \Delta = NC - AC \\]

Positive values favor DBOS. Negative values favor the alternative. This comparison is only meaningful when both implementations satisfy the same business and failure requirements.

### **Lens 1 — Business value at stake (BV)**

This measures what the business stands to gain or lose from executing the process correctly.

| Dimension            | 0 — Negligible         | 1 — Limited         | 2 — Material                         | 3 — Critical                                     |
| -------------------- | ---------------------- | ------------------- | ------------------------------------ | ------------------------------------------------ |
| Business promise     | No meaningful promise  | Convenience         | Meaningful customer outcome          | Contractual, financial, or strategic promise     |
| Policy richness      | Mechanical operation   | A few simple rules  | Multiple interacting rules           | Complex, differentiating business policy         |
| Failure consequences | Harmless retry         | Minor inconvenience | Lost opportunity or customer trust   | Serious financial, legal, or reputational impact |
| Business visibility  | Technical logs suffice | Basic status        | Operations need lifecycle visibility | Customer disputes, intervention, or formal audit |
| Value and volume     | Infrequent, low impact | Limited impact      | Meaningful recurring value           | High-value, high-volume business process         |

Policy richness matters, but it should not be confused with DBOS suitability.

A booking transaction can contain extensive eligibility, scheduling, pricing, and availability rules. That makes the process valuable and potentially complicated. It does not mean that the transaction needs a durable workflow engine.

The relevant question is whether those rules require a durable lifecycle beyond the transaction.

### **Lens 2 — Rule-web and execution fit (RF)**

This is the most important addition to the existing ADR.

It tests whether DBOS can preserve the meaning of the business process without turning business policy into workflow-engine-specific code.

| Dimension             | Poor fit (0)                           | Limited fit (1)                | Good fit (2)                        | Strong fit (3)                                                      |
| --------------------- | -------------------------------------- | ------------------------------ | ----------------------------------- | ------------------------------------------------------------------- |
| Natural lifecycle     | Request-bound                          | Short background operation     | Multiple dependent stages           | Independent, durable business lifecycle                             |
| Rule boundaries       | Continuous, arbitrary decisions        | Difficult to isolate           | Mostly identifiable decision points | Clear policy evaluation at meaningful stages                        |
| Policy ownership      | Rules embedded in workflow             | Mixed ownership                | Mainly domain-owned                 | Entirely domain-owned, workflow only orchestrates                   |
| Temporal semantics    | Undefined                              | Some snapshots and live checks | Most decisions have defined timing  | Every decision has explicit snapshot, recheck, or version semantics |
| Replay compatibility  | Uncontrolled nondeterminism            | Significant refactoring needed | Manageable through explicit steps   | Clear deterministic boundaries and verified integration             |
| Transaction alignment | Required atomicity cannot be preserved | Unverified integration         | Acceptable transactional boundaries | Verified checkpoint and business-mutation semantics                 |

The key question is not merely whether the process has many rules.

It is whether the rules can be evaluated at meaningful, durable execution boundaries.

#### **The three policy-timing models**

Every important business rule should declare which of these models applies.

**A. Snapshot at process initiation**

The process uses the policy or eligibility state captured when it starts.

Example: a customer enters a promotion under the terms applicable at registration.

**B. Re-evaluate when a decision is made**

The process must use current information each time it reaches a meaningful decision point.

Example: a customer unsubscribes during a three-day wait. The system must check current consent before sending another communication.

**C. Apply a versioned policy**

The process must follow an explicitly identified policy version.

Example: an agreement must remain subject to the terms accepted by the customer, even when the business changes its general policy later.

These are business decisions, not DBOS configuration choices.

DBOS's recorded step results do not automatically refresh business state or recalculate an earlier decision. The application must deliberately put fresh policy evaluation after the wait, or explicitly preserve the intended snapshot or policy version.

This is why policy timing belongs in the fit assessment.

A workflow that embeds changing eligibility rules in its control flow can become expensive to maintain because policy changes may affect in-flight workflow versions. Keeping rules in domain services and making the workflow call them at explicit decision points helps isolate that cost.

**The architectural boundary I recommend:**

**Business domain**

Eligibility · Consent · Pricing · Quiet hours · Frequency caps · Authorization · Policy decisions

Domain commands and policy decisions

**DBOS workflow**

Durable sequencing · Waiting · Checkpointing · Resumption · Lifecycle coordination

Controlled business operations

**PostgreSQL and external systems**

Authoritative business state · Transactions · Idempotency · Provider interactions · Decision records

This arrangement gives DBOS responsibility for durable execution without making it the owner of business policy.

It also makes business rules testable independently of the workflow engine.

### **Lens 3 — DBOS adoption cost (AC)**

This measures the actual additional burden of introducing DBOS.

| Dimension             | 0 — Negligible                    | 1 — Limited          | 2 — Material                                      | 3 — Significant                                                    |
| --------------------- | --------------------------------- | -------------------- | ------------------------------------------------- | ------------------------------------------------------------------ |
| Programming model     | Already fits existing design      | Small learning curve | Refactoring and replay discipline                 | Major cognitive and architectural shift                            |
| Versioning exposure   | Runs finish before releases       | Occasional overlap   | Long-lived runs across releases                   | Frequent releases with many active, old-version workflows          |
| Operational footprint | Existing operations suffice       | Minor additions      | New recovery, monitoring, and database procedures | New topology, coordination, permissions, and substantial ownership |
| Scale and edition     | Fully supported at expected scale | Minor constraints    | Additional capacity or configuration needed       | Critical dependence on unavailable or expensive capabilities       |
| Data and security     | Existing boundaries suffice       | Small adaptations    | Payload, PII, or access controls need redesign    | Material security and governance burden                            |
| Team and coexistence  | Familiar execution model          | Some training        | New workflow expertise plus two execution engines | Permanent duplicated infrastructure or high operational complexity |

Versioning deserves particular attention.

The cost of a workflow living for several days is not determined by duration alone.

Consider:

- How often the application is deployed.
- How many workflows remain active during a deployment.
- How frequently the underlying business policy changes.
- How many old workflow versions may need to execute simultaneously.

A long-running process with stable rules and infrequent releases may be easy to manage.

A process that lives for weeks while rules change daily and the application is deployed several times a day is a very different proposition.

That combination can make DBOS's versioning responsibilities substantial.

### **Lens 4 — Non-DBOS counterfactual cost (NC)**

This is where the competing reviews make an especially important contribution.

Do not compare DBOS against the current implementation merely because the current implementation is complicated or defective.

Compare it against the **simplest correct implementation that could reasonably be built without DBOS**.

The candidate alternatives should include:

| Alternative                               | Appropriate use                                                         |
| ----------------------------------------- | ----------------------------------------------------------------------- |
| PostgreSQL transaction                    | Atomic business mutations and consistency                               |
| PostgreSQL scheduled-action/state machine | Durable scheduled decisions, claims, and resumable business state       |
| pg-boss                                   | Independent one-shot jobs and bounded background work                   |
| Custom orchestration                      | Processes that genuinely need a state machine but do not justify DBOS   |
| DBOS                                      | Durable, multi-stage process execution when it provides a net advantage |

Rate the cost of the best viable non-DBOS design:

| Dimension             | 0 — Negligible            | 1 — Limited                    | 2 — Material                              | 3 — Significant                                               |
| --------------------- | ------------------------- | ------------------------------ | ----------------------------------------- | ------------------------------------------------------------- |
| Custom orchestration  | No custom state machine   | A few status transitions       | Several linked stages                     | Substantial workflow engine or continuation machinery         |
| Recovery machinery    | Safe full retry           | Basic retry and reconciliation | Claims, recovery, and stale-work handling | Complex checkpoint and reaper implementation                  |
| Correctness risk      | Straightforward to prove  | Some failure boundaries        | Multiple partial-progress windows         | Known or demonstrated stranding and duplication defects       |
| Lifecycle visibility  | Existing tools sufficient | Basic status required          | Business needs durable execution history  | Operational intervention and process-level oversight required |
| Long-term maintenance | Low ongoing burden        | Occasional maintenance         | Significant custom mechanisms             | Custom orchestration becomes its own product to maintain      |

The scores must be based on implementation evidence, not assumptions.

For example, the proposed PostgreSQL scheduled-action design for lead follow-up deserves a real proof of concept. A table containing a scheduled execution time, status, and a properly claimed action could potentially provide the required wait-and-recheck behavior with less machinery than DBOS.

That alternative has not been proven superior. It should be benchmarked rather than dismissed.

This is the essential counterfactual discipline:

**DBOS must compete against a correct PostgreSQL design, not against a deliberately weak or incomplete alternative.**

## **4. How to interpret the four lenses**

I recommend recording each lens on a 0–3 scale for every dimension, then calculating its average as a descriptive summary.

Do not collapse all four into a grand total.

The decision should use the resulting profile:

| Business value | Rule/execution fit | Net complexity         | Recommended decision                                                                            |
| -------------- | ------------------ | ---------------------- | ----------------------------------------------------------------------------------------------- |
| Low            | Any                | Any                    | REJECT DBOS                                                                                     |
| High           | Poor               | Positive or negative   | DEFER; redesign the process boundaries or use another mechanism                                 |
| High           | Good               | Clearly negative       | Do not adopt; use the simpler alternative or invest in readiness only if justified              |
| High           | Good               | Near zero or uncertain | PILOT DBOS against the strongest alternative                                                    |
| High           | Good               | Clearly positive       | PILOT, then consider ADOPT after acceptance tests                                               |
| Medium         | Good               | Positive               | Evaluate selectively; require evidence that the workload is becoming a durable business process |

The formula

\\[ \Delta = NC - AC \\]

is a useful comparative measure, but not a mathematical proof.

A positive result is not sufficient when rule-web fit is poor. A high business-value score is not sufficient when the process can be implemented safely in one transaction.

The four lenses are deliberately non-compensatory: a particularly high score in one area must not conceal a fundamental problem in another.

### **Three conditions that change the decision**

There are also three kinds of conditions that should override a routine score.

**Durability overrides:** A multi-day wait is itself part of a customer promise; restarting from scratch repeats expensive or irreversible work; or a customer, operator, or regulator needs an execution history. These conditions force a serious DBOS comparison, and usually at least a pilot. They do not automatically authorize adoption.

**Hard exclusions:** No independent durable lifecycle exists; a single PostgreSQL transaction is sufficient; the only motivation is technology standardization; or the proposed implementation would make DBOS the owner of authorization and business-policy decisions.

**Readiness blockers:** There is no workflow versioning policy, no operational recovery owner, no reliable side-effect protocol, or no verified database integration. These do not necessarily make DBOS unsuitable forever. They mean production adoption is not justified yet. A restricted pilot with synthetic effects can still be useful.

This is an important refinement to Z's proposed knockouts: lack of a provider idempotency or unknown-outcome protocol should block consequential production execution, but it need not prevent a controlled pilot that deliberately avoids those effects.

## **5. The business-rule inventory: the missing bridge between policy and DBOS**

I would make this mandatory for every serious DBOS candidate.

A process should not be approved merely because someone draws a workflow diagram and lists its steps. We need to understand the business rules that make those steps meaningful.

For each material rule, document:

| Attribute            | Question                                                   |
| -------------------- | ---------------------------------------------------------- |
| Rule identity        | What business rule is this?                                |
| Business owner       | Who owns the policy?                                       |
| Source of truth      | Where does its authoritative data come from?               |
| Decision point       | At which process stage is it evaluated?                    |
| Evaluation timing    | Snapshot, live re-evaluation, or versioned policy?         |
| Mutable inputs       | What can change while the workflow waits?                  |
| Consequence          | What happens if the rule is missed or applied incorrectly? |
| Implementation owner | Which domain service or component evaluates it?            |
| Audit requirement    | What must be recorded to explain the decision later?       |

The rule inventory should map directly onto the workflow implementation.

For example:

| Business rule             | Evaluation point                       | Implementation owner |
| ------------------------- | -------------------------------------- | -------------------- |
| Lead eligibility          | Before scheduling follow-up            | Domain policy        |
| Customer consent          | Immediately before communication       | Domain policy        |
| Quiet hours               | Immediately before dispatch            | Domain policy        |
| Frequency cap             | Before each communication              | Domain policy        |
| Maximum campaign attempts | Before a recipient attempt             | Domain policy        |
| Cancellation              | At each appropriate execution boundary | Domain command       |
| Delay and resumption      | Across the customer journey            | DBOS                 |

This is how you capture the business value rather than merely automate a sequence of operations.

A useful extension is a durable **business decision record**. For material decisions, preserve the rule identifiers, policy version where applicable, evaluation time, relevant input references, outcome, and reason. Do not automatically persist entire customer records or sensitive payloads.

DBOS workflow history can help explain what the execution did. It should not be mistaken for a complete, business-level audit of why a policy decision was made.

## **6. Applying the consolidated rubric to OpenLevel**

The reviews already contain useful calibration cases. These are judgment calls based on the supplied documents, not fresh code-verification findings.

| Process                              | Business value                      | Rule/execution fit                                                        | My recommendation                                |
| ------------------------------------ | ----------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------ |
| CRUD and ordinary database mutations | Low to high, depending on operation | Poor DBOS justification                                                   | PostgreSQL and domain services                   |
| One-shot notification                | Usually limited                     | Low                                                                       | pg-boss                                          |
| Booking commit                       | High                                | Transaction-anchored, not sequence-anchored                               | PostgreSQL transaction                           |
| Single appointment reminder          | Moderate                            | Low                                                                       | Queue                                            |
| Multi-stage appointment journey      | High                                | Good candidate if it must wait for responses and re-evaluate rules        | PILOT                                            |
| Lead follow-up                       | High                                | Good potential fit; verify policy boundaries                              | PILOT against PostgreSQL scheduled-action design |
| Campaign orchestration               | High                                | Good potential fit, but demanding side-effect and versioning requirements | Gated PILOT                                      |
| Multi-stage agent operations         | Variable                            | Depends on durable waits, human gates, and side effects                   | DEFER or PILOT selectively                       |

The distinctions matter.

**Booking:** The business process is consequential, but its key consistency requirements belong inside an atomic PostgreSQL transaction. DBOS cannot replace that transaction. This matches the existing review's assessment that the booking problem is solved at the database boundary, not by introducing orchestration.&#x20;

DBOS_review\.md



**Lead follow-up:** This is a strong candidate because its business promise spans time, and execution must survive restarts while reevaluating customer eligibility and consent. However, DBOS must demonstrate an advantage over a properly designed scheduled-action implementation. The existing N2 and N3 findings provide evidence of custom recovery complexity, but they do not prove that DBOS is the only or simplest solution.&#x20;

DBOS_review\.md



**Campaign orchestration:** This is potentially valuable because it combines consent, frequency limits, quiet hours, rate limits, and multiple communication attempts. But many of the difficult external-effect problems remain application responsibilities. DBOS does not make an accepted provider request exactly-once, nor does it eliminate the need for stable operation identities, attempt records, idempotency keys, and quarantine after unknown outcomes.&#x20;

DBOS_review\.md



**Agent operations:** The number of tool calls is not the deciding criterion. An agent that performs several short, independent operations may be adequately served by ordinary jobs. An agent whose execution spans days, external decisions, human approvals, consequential actions, and durable recovery is a substantially stronger DBOS candidate.

One other distinction is worth preserving: an appointment reminder is a simple job; an appointment journey that waits for customer confirmation, handles rescheduling, checks changing eligibility, and coordinates subsequent actions may be a durable business workflow. The name of the feature does not determine its architecture.

## **7. Mandatory requirements before production adoption**

The existing `DBOS.md` already has a strong engineering-constraints section. I would retain it and connect it explicitly to the new rubric.&#x20;

DBOS.md



Every adopted workflow should demonstrate:

1. **Business ownership:** Rules and authorization remain in the domain layer. Each important rule has documented evaluation timing and policy-change semantics.
2. **Stable identity:** One logical business operation maps to one intentional workflow identity. HTTP retries cannot accidentally launch duplicate workflows.
3. **Deterministic execution:** Nondeterministic operations are behind appropriate DBOS steps or transactions.
4. **Side-effect safety:** Consequential effects use stable operation identities, provider idempotency where available, and quarantine or reconciliation for unknown outcomes.
5. **Transaction correctness:** The actual DBOS datasource integration has been verified. An ordinary PostgreSQL transaction must not be assumed to include the DBOS checkpoint automatically.
6. **Version compatibility:** The deployment policy accounts for workflows that outlive the application version that started them.
7. **Operational recovery:** Retry, terminal failure, cancellation, resumption, intervention, alerting, and retention are defined.
8. **Security and payload discipline:** Workflow state carries identifiers and compact context, not credentials or unnecessary customer data.
9. **Execution ownership:** A workload has one authoritative execution engine. pg-boss and DBOS must not independently process the same business operation.
10. **Measured operating cost:** Connection budgets, database storage, workflow volume, concurrent waits, edition limitations, and operator workload are tested against realistic scale.

A pilot must prove more than a happy-path execution. It should test crashes at important transition boundaries, retries after an ambiguous side effect, policy changes during a wait, workflow-version changes, cancellation races, and recovery after worker replacement.

## **8. The decision record**

I recommend retaining the existing five possible outcomes—REJECT, DEFER, PILOT, ADOPT, and RETIRE—but requiring the following evidence for every proposal.

**Business case:** What customer or business promise does the process fulfill? What is the value of executing it correctly?

**Policy map:** What rules govern it? Who owns them? When are they evaluated? What happens when policies or customer data change during execution?

**Execution requirements:** What must survive a process restart, deployment, or worker replacement? What must be resumed, cancelled, or reconciled?

**Counterfactual:** What is the simplest correct PostgreSQL or pg-boss implementation? What would it need to build and maintain?

**DBOS comparison:** Which custom mechanisms does DBOS eliminate? What new programming, versioning, operational, and infrastructure obligations does it introduce?

**Evidence and confidence:** Which conclusions come from production measurements, incidents, tests, code inspection, or assumptions? What remains unproven?

**Reversal conditions:** What future change would cause us to reconsider the decision? Examples include a substantial increase in concurrent workflows, longer process lifetimes, more frequent policy changes, or recurring recovery incidents.

Re-score when material requirements change, a significant stranding or duplication incident occurs, workload volume changes materially, or the team changes its release cadence. A periodic architectural review is also appropriate.

## **9. The revised governing principle**

I would replace the existing idea of a single workflow-complexity score with this:

> **OpenLevel adopts DBOS when a valuable business process requires durable execution, its business rules can be expressed faithfully at explicit execution boundaries, and DBOS reduces the total complexity of implementing and operating that process compared with the simplest correct alternative.**

And I would add a second statement:

> **The business domain owns the meaning of the process. DBOS owns the durability of its execution. PostgreSQL owns the authoritative business state.**

These are three separate responsibilities.

The business value comes from correctly modelling the process and its rules. DBOS may make it substantially easier to execute that process reliably across time, failures, and deployments. But it must earn that role through a demonstrated advantage.

My recommendation is to adopt the four-lens model as the revised governing rubric for ADR-001, **without hard-coded aggregate adoption thresholds**. Keep the current A–D classification as an initial triage mechanism, keep the engineering constraints, and replace the existing 0–14 score as the primary decision instrument.

The most important shift is this: **we are not asking how complicated a workflow looks. We are asking how much business value depends on getting its entire lifecycle and rule system right, and whether DBOS is the least complicated way to guarantee that result.**
