## claude

Finished reading all three files. Before I write up the rubric, I'm checking your OpenLevel notes for anything that changes the comparison.

I read all three. DBOS.md is a good policy for the shape of execution but is missing what you're asking about, so I'll start with what's missing and then give the rubric.

## What DBOS.md covers and doesn't

The default-no stance, the A to D classification, the gates, the mandatory constraints (§7) and the REJECT/DEFER/PILOT/ADOPT/RETIRE template (§9) are all worth keeping. For your goal, though, it has three gaps:

1. **The score measures execution shape, not value.** All seven dimensions are technical (lifetime, stages, waiting, recovery, side effects, coordination, humans). A complicated-looking but low-stakes process scores high, and a simple-looking but high-stakes one scores low. The document's own escape hatch ("a critical multi-day wait can qualify even at a low score") concedes that the sum isn't the real decision.
2. **Business rules and policy aren't a factor at all.** This is the biggest gap, because the rule web cuts both ways (next section).
3. **Cost is listed but never weighed.** §7 names versioning, determinism, edition limits and so on, but nothing scores them. Gate 4 compares DBOS against the current pg-boss implementation, which is the wrong comparator.

There are also two internal inconsistencies. writeup3 rates "scheduled reminders" as High DBOS suitability, while DBOS.md §5B says a simple one-off scheduled notification can stay a queued job. And writeup4 §12 says "Adopt" while §9 requires a PILOT first. writeup4's own phases are effectively a pilot, so I read it that way.

## The rule web cuts both ways

DBOS gives you durable sequencing and a record of what each run did. It does nothing for the rules themselves, so a rule-heavy process can come out better or worse depending on where its rules live.

- **Separable rules.** If the rules (consent, quiet hours, frequency caps, eligibility, tenant config) live in the domain layer and the workflow only calls them as steps, the workflow is a thin sequencing shell. The execution history doubles as an audit trail, and policy changes don't touch workflow code. Here rule density raises DBOS's value.
- **Entangled rules.** If policy branching lives in the workflow body, every policy change is a workflow code change. In-flight runs then need draining, patching or version pinning. Here rule volatility raises DBOS's cost.
- **Policy timing.** Step results are memoized. A consent check made before a three-day sleep is frozen for that run, so a revocation during the wait never reaches it unless the workflow re-checks after waking. Both writeups' examples do re-check. That should be a stated requirement, not an accident.

## The rubric

Don't sum a single score. First apply hard triggers and vetoes, then rate four lenses at 0 to 3 with written evidence, and read them as a profile.

**Step 0: Triggers and vetoes (non-compensatory)**

| | Condition |
|---|---|
| Trigger | A business promise depends on a wait of hours or more that must survive restarts or deploys |
| Trigger | The process waits on a human or external event as part of its definition |
| Trigger | Partial progress has irreversible side effects, so a full restart isn't safe |
| Veto | The whole operation can safely restart from scratch, or one Postgres transaction suffices |
| Veto | The only motive is standardizing execution |
| Veto | It needs a capability outside the edition you'll run (e.g. suspending sleepers at scale) with no workaround |
| Veto | You can't operate a versioning policy (e.g. can't keep old code running while old workflows drain) |

A trigger forces a real comparison. It does not force adoption.

**Lens 1: Value at stake (what durability protects)**

| Factor | 0–1 | 2–3 |
|---|---|---|
| Promise criticality | Harmless or easily retried | Lost revenue or trust; contractual, legal or financial |
| Irreversible effects | None, or one idempotent call | Customer-visible sends, money, regulated communications |
| Cost of restart | Cheap and detectable | Repeats costly work or can't be detected |
| Time span | Request-bound to minutes | Hours to days or longer |
| Accountability | Nobody asks why a run did what it did | Customer or regulator needs per-run explanation |

**Lens 2: Rule and policy web**

| Factor | 0–1 | 2–3 |
|---|---|---|
| Density | A couple of checks | Many interacting rules at several decision points |
| Re-evaluation need | Decide once | Must re-check at resume, or revocation must reach in-flight runs |
| Volatility | Policy rarely changes | Policy changes within a run's lifetime |
| Entanglement | Rules behind domain steps or in data | Rules branch inside workflow control flow |

High density and re-evaluation with low entanglement adds to the value lens. High entanglement and volatility adds to the cost lens.

**Lens 3: Accidental complexity (what DBOS adds)**

| Factor | 0–1 | 2–3 |
|---|---|---|
| Programming-model load | Linear flow, coarse steps | Loops, dynamic fan-out, heavy nondeterminism |
| Version exposure | Short runs or rare releases | Long lifetimes combined with frequent releases (lifetime × release cadence, the cost that scales silently) |
| Operational surface | Fits existing ops | New topology, permissions, connection budget, retention, stuck-run alerting |
| Edition and scale | Few concurrent sleepers | Many sleepers, or Enterprise/Conductor features needed |
| Coexistence tax | One engine | pg-boss alongside DBOS, plus an outbox for workflow-start handoff |
| Residual custom work | DBOS removes most of the burden | Idempotency protocol, attempt records, reconciliation and authz all remain yours |

**Lens 4: The counterfactual (what you'd build instead)**

Compare DBOS against the simplest correct Postgres design, not the current implementation. N2 and N3 both come from a run row and a wait row committed separately. For the plain "wait, re-check, act" case, a single scheduled-action row (`run_at`, status, claimed with `SKIP LOCKED`, eligibility re-checked at fire time) might remove those windows without a workflow engine. I haven't seen your code, so treat that as a hypothesis for the pilot to test.

| Factor | 0–1 | 2–3 |
|---|---|---|
| Mechanisms needed without DBOS (wait records, continuations, reaper, claims, definition hash, completion transitions) | 0 to 3 | 4 or more |
| Already built and crash-tested? | Yes, so little is avoided | No, so DBOS avoids real work |

**Reading the profile**

| Value | Cost (incl. entanglement) | Counterfactual | Decision |
|---|---|---|---|
| High | Low or Med | High | PILOT, then ADOPT |
| High | any | Low | Build the simple design; DEFER DBOS |
| High | High | High | Narrow PILOT, only after the versioning policy exists; otherwise DEFER |
| Med | any | any | Simple design first; revisit if the counterfactual grows |
| Low | any | any | REJECT |

Every verdict also records its confidence and one reversal condition, such as "if concurrent sleepers exceed N" or "if lifetimes exceed 7 days and releases are weekly." Set those thresholds from measurement, not by guessing.

## Calibration against your writeups

These are my judgment calls from the documents, not a code review.

| Process | Value | Rule web | Cost | Counterfactual | Call |
|---|---|---|---|---|---|
| Lead follow-up (multi-day wait, re-check, send) | High | Med–High, separable if the re-check is a domain step | Med (versioning bites at multi-day lifetimes) | High, given N2/N3 | PILOT, benchmarked against the single-row design |
| Single appointment reminder | Med | Low | Low | Low | Queue, not DBOS |
| Booking commit plus idempotency (N4) | High | High but atomic | n/a | Low (one Postgres transaction fixes it) | Not DBOS, as writeup4 §5 already says |
| Campaign orchestration | High | High (consent, frequency, quiet hours, rate limits) | High (fan-out; N5 protocol stays yours) | Med–High | PILOT after lead follow-up |
| Agent tool chains | Med–High | Med (authz boundary) | Med–High (nondeterminism, payload discipline) | High | DEFER until the pilot proves the model; keep steps coarse |

Of the four Review 12 findings, only N2/N3 are a clean DBOS win. N4 is fixable in plain Postgres, and N5 needs an external-effect protocol that DBOS cannot replace. That supports a narrower reading than writeup4's "strategic orchestration engine": DBOS for long-wait, multi-stage, rule-heavy workflows whose rules are separable, after a pilot.

If you'd like, I can fold this into DBOS.md as a replacement for §4 plus an updated §9 template, as ADR-002 or a revised ADR-001.



## deepseek

# Rethinking the DBOS Adoption Rubric

## Why the current rubric is necessary but not sufficient

The DBOS.md rubric is a good *filter*. It prevents the most common failure mode — introducing a durable workflow engine because a developer saw `setTimeout` or a queue and reached for a framework. But it conflates two different questions into one score, and it omits the dimension you correctly identify as central: **the business value of getting the process right, given its web of rules and policies.**

The existing rubric scores *execution mechanics* — lifetime, stages, waiting, recovery, side effects, coordination, human involvement. Those are all real. But they are **cost-side** dimensions. They tell you when the process is hard to execute. They do not tell you when the process is **worth executing durably** — which is a function of business consequence, policy density, and the cost of getting it wrong.

That asymmetry produces two kinds of bad decisions:

- A policy-rich, multi-day process with reversible side effects scores "medium" and gets dismissed, even though a stranded workflow would break a customer promise.
- A mechanically complex but business-trivial batch operation scores "high" and gets DBOS, even though restart-from-scratch is perfectly acceptable.

The fix is not to add more dimensions to the same score. It is to **separate essential complexity from accidental complexity**, and to make the decision a *comparison between two full implementations* rather than a threshold on one number.

---

## The revised framework: three axes, one decision

### Axis 1 — Business Essential Complexity

This axis measures **how much correct execution matters**, and how much of that correctness is carried by a web of business rules and policy that must be evaluated at multiple points in time.

| Dimension | 0 | 1 | 2 | 3 |
|---|---|---|---|---|
| **Consequence of failure** | Retry-from-scratch is harmless | Minor customer inconvenience | Lost business or duplicate communication | Broken promise, financial loss, regulatory exposure |
| **Policy density** | No meaningful rules; mechanical | A few simple conditions | Multiple eligibility checks, branches, exceptions | Interacting rules, temporal constraints, compliance conditions |
| **Temporal rule evaluation** | All rules evaluated once | Rules re-checked within a short window | Rules re-evaluated across days/weeks; may have changed since start | Rules themselves are versioned; workflow must apply the correct policy version at each step |
| **Auditability / oversight** | Basic logs sufficient | Operational debugging | Customer-facing audit trail | Human approval gates, dispute resolution, regulatory audit |
| **Irreversibility of effects** | Fully compensable | Reversible with effort | Some irreversible effects (sent message, published post) | Consequential financial or legal effects |

**Score 0–4:** simple process; ordinary code.
**Score 5–8:** real business process; durability merits serious consideration.
**Score 9–12:** high-value process; durable orchestration is likely justified **if** Axis 3 favors it.

The critical addition here is **temporal rule evaluation**. This is the dimension that most directly captures your concern. A process whose rules must be re-evaluated at wake-up time — because eligibility, policy, or customer state may have changed — is not merely "long-running." It is a process whose **business logic is inherently temporal**, and that is precisely the class of process for which durable checkpoints provide the most value. DBOS does not evaluate the rules for you, but it lets you checkpoint the workflow at each rule-evaluation boundary so that a restart resumes at the *correct* policy state rather than replaying from the start.

### Axis 2 — Execution Mechanics

This is the existing rubric, retained as a **necessary-condition filter** rather than a scoring axis. A workflow that fails to trigger even the low bar here (e.g., genuinely request-bound, no independent lifecycle, no durable wait) should not proceed to Axis 3 at all. Use the existing Gate 1 and Gate 2 from DBOS.md as pass/fail checks, and score the existing seven dimensions only for workflows that pass.

### Axis 3 — Comparative Accidental Complexity

This axis is the one the current rubric most under-specifies. It measures the **net difference** between two concrete implementations.

| Dimension | −2 (DBOS much worse) | −1 | 0 | +1 | +2 (DBOS much better) |
|---|---|---|---|---|---|
| **Custom orchestration eliminated** | None; we have no custom state machine | Minor | Some | Substantial reaper/continuation/claim logic removed | DBOS replaces a fragile, hard-to-maintain custom workflow engine |
| **Programming-model shift** | Team unfamiliar with deterministic replay, step boundaries | Steep learning curve | Manageable with docs | Team already thinking in workflow terms | Team has DBOS experience |
| **Workflow versioning burden** | Frequent breaking workflow changes; no draining strategy | Long-lived workflows outlive releases | Occasional versioning | Workflows short enough to drain between releases | Versioning strategy already understood and tooled |
| **Operational burden added** | New monitoring, schema, permissions, connection budget all unowned | Significant new ops surface | Manageable | Existing observability and DB ops transfer | DBOS state is inspectable through existing Postgres tooling |
| **Migration cost from current system** | Large rewrite of working code | Moderate migration | Incremental | Small pilot | Greenfield; no migration |
| **Redundant infrastructure deprecated** | None; we keep two engines permanently | Minor overlap | Some | pg-boss scope reduced | pg-boss fully retired |

**Sum the axis.** Positive means DBOS reduces net accidental complexity; negative means it adds it.

---

## The decision, as a matrix — not a threshold

| | **Axis 1 low (0–4)** | **Axis 1 medium (5–8)** | **Axis 1 high (9–12)** |
|---|---|---|---|
| **Axis 3 positive** | Do not use DBOS; the process doesn't justify it | **Strong DBOS candidate** — proceed to pilot | **Adopt DBOS** — the business case is clear |
| **Axis 3 neutral** | Do not use DBOS | **Evaluate carefully** — pilot with explicit acceptance criteria; the business case is real but the net complexity win is unproven | **Pilot DBOS** — high business value; justify the added complexity through the pilot |
| **Axis 3 negative** | Do not use DBOS | **Do not adopt yet** — close the accidental-complexity gaps (versioning strategy, ops ownership) before piloting | **Invest in readiness first** — the business case justifies DBOS, but adoption would relocate complexity rather than reduce it; do the integration proof and team enablement before committing |

The key move is the **high-business-value / negative-axis-3 cell**. The old rubric would reject DBOS there. The revised framework says: the business case is strong; the implementation cost is high; so **fund the readiness work** (integration proof, versioning policy, ops ownership) rather than either adopting prematurely or dismissing the need. That is the honest answer for a process like lead follow-up with dense eligibility rules and multi-day waits, if the team is new to durable execution.

---

## The "web of business rules" as its own consideration

Your instinct is correct: policy density is not just a business-value input. It interacts with DBOS in three specific ways the current rubric does not name.

**1. Rules that must be re-evaluated at wake-up time favor DBOS.**
A workflow that sleeps three days and then checks "is this lead still eligible under current policy?" needs the rule evaluation to happen *after* the wait, against *current* state. With a custom state machine, the developer must remember to re-query rules at the continuation boundary — and must handle the case where the rule itself has changed. DBOS checkpoints the step boundary, making the re-evaluation point explicit and recoverable. The business rule is still application-owned, but the *timing* of its evaluation is durable.

**2. Rules that are versioned over time create a workflow-versioning requirement.**
If a campaign's eligibility policy changes mid-flight, in-progress workflows must decide whether to apply the old or new policy. This is a business decision, but it is also a *workflow versioning* decision — and the current rubric scores versioning only as an operational cost. The revised Axis 3 treats it as a dimension because it is the cost most likely to surprise a team adopting DBOS for a policy-rich process.

**3. Policy density raises the cost of getting recovery wrong.**
A process with one rule and one side effect is easy to retry safely. A process with five interacting rules, three external checks, and two irreversible effects is not — and the cost of a stranded or duplicated execution scales with policy density. This is the mechanism by which "web of business rules" increases the *value* of durable execution: not because DBOS evaluates the rules, but because the rules make the failure consequences of incorrect execution much higher.

The revised Axis 1 captures this directly through the **temporal rule evaluation** and **policy density** dimensions. If a workflow scores high on both, and Axis 2 passes the durability gates, the case for DBOS is materially stronger than the old score-based rubric would indicate.

---

## What this rubric does not do

It does not let you skip the **adoption decision template** in DBOS.md §9. The template is where the business case, failure analysis, and comparative complexity are actually written down. The rubric is a triage tool; the template is the record. A workflow that lands in the "strong candidate" cell must still produce a written justification, and the decision must still be one of REJECT / DEFER / PILOT / ADOPT / RETIRE — not an implicit slide into implementation.

It also does not remove the **engineering constraints** in §7 (determinism, idempotent side effects, transaction boundaries, workflow identity, versioning, payload discipline, recovery observability, operational cost). Those are obligations that attach *after* adoption, and the rubric should not be read as saying they are optional for high-scoring workflows.

---

## The one-line rule

> **Adopt DBOS when the business cost of incorrect execution — measured by consequence, policy density, temporal rule evaluation, auditability, and irreversibility — is high, the workflow passes the durability gates, and the net accidental complexity of DBOS is lower than the custom orchestration it replaces.**

The current rubric's seven-dimension score is a useful input to the durability gates and a useful sanity check. It is not the decision. The decision is a comparison between two complete implementations, weighed against the business value of getting a policy-rich process right.



## Z

Fair enough — here's the plain version.

## Verdict on DBOS.md's criteria

The skeleton is right: default to no, Class A–D triage, Gate 4's comparative question ("would we otherwise build this machinery ourselves?"). Three real gaps:

1. **The value side is under-measured.** Gate 3 only counts *failure* cost. It never asks what the process's web of business rules is *worth to capture* — policy density (eligibility, consent, caps, quiet hours), whether workflow state is business data ops actually manages ("who's waiting, who's stuck"), and whether the process is a product surface or plumbing.
2. **No fit test.** The score never asks whether DBOS can *hold* the rule web without distortion. DBOS records a sequence; rules that must fire continuously (consent revoked mid-wait) or read volatile state mid-decision fight the deterministic-replay model, and every rule change becomes a versioning event. Fit depends on the rules, not the step count.
3. **The tax isn't priced.** Section 7 inventories DBOS's obligations (determinism, versioning, payloads, ops topology, licensing) — but *after* adoption, as prose. The 0–14 score only measures the problem, equally weighted, and the ADR's own caveats admit the sum doesn't decide.

## The rubric: four scores, 0–3 per dimension

| Lens | Dimensions | What it answers |
|---|---|---|
| **BV** — business value at stake (0–15) | promise criticality · policy density · state-as-business-data · failure blast radius (duplicate/stranded) · value × volume | What is capturing this process worth? |
| **FT** — rule-web fit (0–15) | rules stage-anchorable? · inputs staged vs live reads (determinism) · durable waits/events/human gates · atomic coupling of mutations and checkpoints · cancel/resume/intervene needs | Can DBOS hold this web faithfully? |
| **AC** — accidental complexity (0–18) | determinism refactor · versioning tax (rule-change freq × in-flight duration × count) · payload/PII governance · ops/recovery topology (Conductor, Enterprise sleep, Neon connections) · team/cognitive tax · coexistence with pg-boss + overhead | What does adopting cost *here, this team, this scale*? |
| **CW** — counterfactual cost (0–15) | custom state machine · custom recovery/reaper/claims · visibility you'd never build · correctness risk of hand-rolled boundaries (weight by evidence — Review 12: 10/11 partial) · opportunity cost | What does *not* adopting cost? |

**Anchors that matter most:** BV2 = 3 when the rule web is differentiating logic under active change; FT1 = 0 when rules must fire continuously rather than at stage boundaries; AC2 = 3 when long-lived workflows meet frequent rule changes; CW4 = 3 when the hand-rolled path has already demonstrated the defect class (your N2/N3 stranding windows).

## Decision rule

- **Knockouts → reject regardless of score:** no durable-progress requirement; business decisions/authorization would move *into* the engine; rule web can't be stage-anchored even after reasonable redesign; consequential external effects with no idempotency/quarantine protocol.
- **Overrides → at least pilot:** multi-day durable wait *is* the promise; restart would repeat expensive operations; contractual audit of process history needed.
- Otherwise: **V = BV + FT** (0–30), **D = CW − AC** (net complexity change).
  - **Adopt** when V ≥ 18 **and** D ≥ 4
  - **Pilot** when V ≥ 18 and D 0–3 (crash-boundary acceptance script, as in your phases)
  - **Defer** when V 12–17 and D ≥ 0 (watchlist — jobs accrete into workflows)
  - **Reject** when V < 12 or D < 0
  - **Retire** an existing DBOS workflow when it re-scores reject twice.

The trick is that it's compensatory within lenses but non-compensatory at the edges — knockouts and overrides carry the "not black and white" nuance the linear score couldn't.

## Applied to your portfolio

| Process | Verdict | Why |
|---|---|---|
| CRUD, one-shot notification, reports | Reject | V < 12 |
| Contact import | Reject/defer | V ~14, D negative — pg-boss is fine |
| **Booking transaction** | **Reject despite high BV (~11)** | Rules are transaction-anchored, not sequence-anchored; D strongly negative. Fix N4 inside the PostgreSQL transaction — matches your writeup4 note |
| Lead follow-up | Pilot → adopt | V ~22, D ~3; the N2/N3 class is exactly what DBOS removes |
| Campaign | Pilot, gated | V high but D ~0: versioning + PII payload tax ≈ machinery saved. Passes only with the external-effect protocol (idempotency keys, attempt records, quarantine) — K4 |
| Agent chains, approval flows, appointment *journeys* | Pilot → adopt | Waits/events/human gates integral; D positive |

Note the appointment case splits: a reminder **journey** adopts, a one-shot **dispatch** rejects — which resolves the tension between ADR §5 (reminders preferred) and §6.8 (notification dispatch rejected).

One governance rule to make it stick: no 2–3 score without evidence (incident ticket, volume metric, rule-location audit listing each rule, where it fires, and where it would live). Re-score on rule changes touching in-flight workflows, ~10× volume shifts, any stranding incident, and a quarterly sweep to catch accreting jobs.

