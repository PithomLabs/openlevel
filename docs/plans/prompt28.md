Use this prompt with your coding agent. It starts from the one-line M4 fix, requires independent adversarial review before publication, and establishes the Local-First, CI-Confirmed workflow for all subsequent OpenLevel work.

# **Prompt 28 — Local-First Verification, Independent Adversarial Review, and M4 Fix Acceptance**

## **Objective**

Continue from the current OpenLevel working tree and the M4 ledger-race cleanup fix described below.

The immediate objective is to independently review the fix, perform every verification currently possible in the developer's local environment, and determine whether the change is safe to publish.

The broader objective is to establish **Local-First, CI-Confirmed** as the permanent development and verification workflow for OpenLevel.

Do not assume that previously reported test results are independently verified. Inspect the actual working tree and reproduce whatever can be reproduced.

---

## **1\. Current implementation state**

One-line fix applied in:

`phase0/p2/ci-ledger-race.mjs`

Exact change:

```
- await observer.query(`DELETE FROM app.p2_provider_ledger WHERE operation_id = $1`);
+ await observer.query(`DELETE FROM app.p2_provider_ledger WHERE operation_id = $1`, [op]);
```

The M4 race proof is intended to remain unchanged.

Reported audit:

* All other parameterized SQL calls were already correctly bound.  
* `op` is generated once per run using `ci-race-${Date.now()}`.  
* Cleanup uses that same operation ID.  
* Cleanup remains in the existing `try` block.  
* Pool shutdown remains in `finally`.  
* The race ordering and all four assertions are unchanged.

Reported validation:

* `node --check` passes.  
* Phase 0 unit tests: 17 files, 284 tests pass.  
* Root and Phase 0 typechecks pass.  
* Docker-backed ledger-race and integration checks were not run locally because Docker and a local PostgreSQL server are unavailable.  
* Nothing has been committed.

These are reported results to reproduce where possible, not unquestionable evidence.

## **2\. First: inspect the actual working tree**

Before doing anything:

1. Confirm the active branch is `phase0/p2-staging-readiness`.  
2. Inspect `git status`.  
3. Inspect the complete diff.  
4. Confirm the M4 fix is exactly the intended one-line parameter-binding correction.  
5. Check for unrelated modifications, untracked files, accidental generated artifacts, or changes to previously reviewed files.

Do not stage, commit, push, merge, or modify GitHub.

If the actual working tree differs materially from the supplied description, stop and report the discrepancy before making changes.

## **3\. Independent adversarial review of the M4 fix**

Review `phase0/p2/ci-ledger-race.mjs` as though the original implementation came from another engineer.

Inspect every SQL query invocation, not just the corrected line.

Verify:

* Every positional placeholder has a corresponding parameter.  
* Every parameter is bound to the intended value.  
* The cleanup uses the exact operation ID generated for this run.  
* Cleanup cannot delete another test run's records.  
* The cleanup does not accidentally execute before the race assertions.  
* The race still holds transaction A open while transaction B attempts the same operation.  
* The observer actually detects B waiting on the database lock.  
* The first transaction commits before the losing transaction is evaluated.  
* The losing insert must receive PostgreSQL `23505`.  
* Exactly one acceptance must survive.  
* Sequential duplicate acceptance must also receive `23505`.  
* All connections and pools are released or closed on success and failure.  
* A failed assertion cannot be silently converted into a successful test exit.

Look for subtle issues involving asynchronous query execution, transaction state, cleanup failures, and process exit behavior.

Do not weaken any assertion to make the test pass.

## **4\. Permanent Local-First verification policy**

Apply the following workflow to this task and every subsequent OpenLevel implementation, bug fix, remediation, and refactor.

**Never make GitHub Actions the first place where a locally reproducible failure is discovered.**

### **Stage A — Local checks that do not require Docker**

Run all applicable checks before considering publication:

1. Syntax checks for modified JavaScript and TypeScript files.  
2. Focused tests for the modified component.  
3. Complete Phase 0 unit tests.  
4. Root TypeScript checks.  
5. Phase 0 TypeScript checks.  
6. Static checks and relevant package scripts.  
7. Git diff and whitespace validation.  
8. Secret and accidental configuration exposure checks.

Reproduce the reported 284-test result and both typecheck results.

### **Stage B — Detect local infrastructure capabilities**

Check whether the local environment has:

* Docker CLI.  
* A functioning Docker daemon.  
* A usable local PostgreSQL server.  
* Required project dependencies.  
* The configuration needed to execute the relevant tests safely.

Do not assume that Docker CLI availability means the Docker daemon is running.

Do not request access to, display, inspect, or modify `.env` files or secrets.

Do not ask the developer to install Docker. The current Mac does not have Docker, and Docker installation is not a prerequisite for continuing development.

### **Stage C — Run database-backed checks locally when supported**

When Docker or a suitable local PostgreSQL instance is available, run the actual database-backed tests locally.

For P2, this includes:

1. P2 schema application.  
2. DBOS system migrations.  
3. Real worker boot and graceful shutdown.  
4. Staging-apply verification.  
5. Ledger-race proof.  
6. Repeated ledger-race execution to detect nondeterminism.  
7. Relevant integration checks.  
8. Docker image build and packaging smoke tests.

Use disposable, isolated local infrastructure.

Do not connect these tests to Fly.io, Neon staging, production databases, or any external customer environment.

If local database infrastructure is unavailable, mark these checks **NOT RUN — local infrastructure unavailable**. Do not claim they passed, do not weaken them, and do not waste time attempting impossible local execution.

### **Stage D — Local pre-publication gate**

Before recommending publication, produce a verification matrix with:

* Check name.  
* Exact command.  
* PASS, FAIL, or NOT RUN.  
* Relevant output or evidence.  
* Explanation for every NOT RUN result.

All applicable local checks must pass.

Any failure blocks publication until corrected and reverified.

### **Stage E — GitHub Actions confirmation**

Only after the applicable local checks pass should the developer publish the reviewed changes.

GitHub Actions then independently confirms:

* The committed code works in CI.  
* PostgreSQL-backed tests pass.  
* Worker boot and staging-apply proofs pass.  
* Ledger-race proof passes.  
* Docker packaging and smoke tests pass.  
* All required workflow jobs succeed.

For the current M4 fix, the next Actions run must demonstrate all four `RACE-OK` assertions, followed by:

```
ledger race: PASS (constraint arbitrated, exactly one acceptance)
```

The job must exit with code zero.

CI remains mandatory. Local verification does not replace CI.

---

## **5\. Current machine limitations**

The developer's Mac currently has no Docker and no local PostgreSQL server.

Therefore:

* Run all checks available locally.  
* Do not ask the developer to install Docker.  
* Do not misrepresent Docker-backed checks as locally verified.  
* Keep Docker-backed checks in GitHub Actions until local infrastructure becomes available.  
* Make the verification process automatically distinguish PASS from NOT RUN.  
* Never treat NOT RUN as PASS.

The workflow must adapt to the actual environment instead of assuming infrastructure that does not exist.

## **6\. Scope and change discipline**

For this task:

* Prefer no additional source changes.  
* The intended fix is one parameter-binding correction.  
* Do not refactor the race proof.  
* Do not change the unique constraint.  
* Do not change ledger schema or database migrations.  
* Do not alter P2 worker boot, staging setup, or P3.  
* Do not introduce new orchestration or infrastructure abstractions.  
* Do not add unrelated tests or dependencies without a demonstrated need.

For future tasks, use the same local-first verification discipline without automatically expanding the architecture or test framework.

## **7\. Operational and Git boundaries**

The developer retains control of publication and infrastructure.

You are not authorized to:

* Commit or push Git changes.  
* Merge a pull request.  
* Deploy to Fly.io.  
* Connect to or mutate Neon staging or production.  
* Execute staging migrations or operational proofs against external environments.  
* Change secrets, credentials, or protected configuration.

These require separate explicit authorization.

## **8\. Required final report**

Return:

### **A. Independent review verdict**

Choose one:

* APPROVE  
* APPROVE WITH NON-BLOCKING FINDINGS  
* FIX BEFORE PUBLICATION  
* INSUFFICIENT EVIDENCE

Explain the evidence.

### **B. Actual diff**

Show the exact changed files and lines. Confirm whether the intended one-line correction remains the only source change.

### **C. Local verification matrix**

List exact commands, results, and evidence. Distinguish PASS, FAIL, and NOT RUN.

### **D. Adversarial findings**

Report all findings, including low-severity issues that could affect correctness, test reliability, cleanup, or repeatability.

Do not invent findings or conceal uncertainty.

### **E. Publication recommendation**

State whether the developer may publish the change.

If approved, explicitly identify the remaining GitHub Actions checks required before considering M4 verified.

Stop without committing, pushing, merging, deploying, or touching external infrastructure.

---

## **Permanent working principle**

**Local-First. CI-Confirmed. Owner-Authorized Operations.**

Discover locally reproducible failures before publication. Use GitHub Actions to confirm the committed result in the real CI environment. Only proceed to staging operations after separate owner authorization.

This workflow applies to all future OpenLevel work.

The key distinction is that the agent must report **PASS, FAIL, or NOT RUN** honestly. Lack of Docker must never be disguised as successful local verification, and it must not prevent progress on checks your Mac can already run.

