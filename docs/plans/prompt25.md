Use this prompt for an independent reviewer or coding agent. It is designed to challenge the actual remediation rather than simply confirm that the reported tests pass. It explicitly prohibits making changes.

# **Adversarial Code Review — P2 CI Remediation**

## **Role**

Act as an independent senior staff engineer conducting an adversarial review of the P2 CI remediation in `PithomLabs/openlevel`.

Your responsibility is to find defects, incomplete fixes, hidden regressions, misleading tests, and violations of existing architectural boundaries.

You are NOT the implementation agent. Do not modify the code. Do not fix findings. Do not commit, push, merge, deploy, or mutate GitHub resources.

Be skeptical. Do not accept the implementation report, test names, comments, or developer explanations as proof. Verify behavior from the actual source code, tests, Git diff, and CI evidence.

## **1\. Review target and baseline**

Repository: `PithomLabs/openlevel`

Branch: `phase0/p2-staging-readiness`

Pull request: \#2, if already published.

Review the complete remediation relative to the actual PR base, not just the last commit.

Inspect:

* All committed changes relative to the PR base.  
* All staged changes.  
* All unstaged changes.  
* All untracked implementation and test files.  
* Relevant existing source files and tests needed to understand their behavior.

Do not silently omit untracked files merely because they do not appear in `git diff`.

The remediation addresses three failures from GitHub Actions run:

[https\://github.com/PithomLabs/openlevel/actions/runs/43719980758](https://github.com/PithomLabs/openlevel/actions/runs/43719980758)

Original failures:

1. `integration`: PostgreSQL error `42P01`, relation `public.p2_probe_log` does not exist.  
2. `p2-boot-proof`: role `p2ci_worker` does not exist when DBOS attempts to grant privileges.  
3. `p2-packaging`: an expected exit code of 2 terminates the Bash step before the assertion executes because of `bash -e`.

The implementation report claims:

* `phase0/setup-contracts.ts` extracts `PUBLIC_TRUNCATE_TABLES` and `PROTOTYPE_INVENTORY_SCHEMAS`.  
* `phase0/setup-db.ts` consumes those contracts.  
* `phase0/p2/setup-staging.mjs` creates the runtime role through `ownSys` before `DBOS.migrate()`.  
* `.github/workflows/phase0.yml` uses explicit Bash exit-code capture.  
* Regression tests were added to `setup-contracts.test.ts`, `setup-staging.test.ts`, and `packaging.test.ts`.  
* Local unit tests: 17 files, 277 tests passed.  
* Root typecheck and Phase 0 typecheck passed.  
* Docker-backed validation was not run locally.

Treat every item above as a claim to verify.

## **2\. Review A — schema boundary and setup contracts**

Original defect:

`phase0/setup-db.ts` attempted to grant TRUNCATE on `public.p2_probe_log`, although the P2 schema creates that table under `app`.

The P2 staging contract explicitly places its proof tables in `app`. Do not allow the fix to conceal this mismatch by moving P2 tables into `public`.

Inspect:

* `phase0/setup-contracts.ts`  
* `phase0/setup-contracts.test.ts`  
* `phase0/setup-db.ts`  
* `phase0/p2/schema.sql`  
* `phase0/provisioners/ownership.ts`  
* Native and Testcontainers teardown implementations  
* Existing P1/P3 integration tests  
* All consumers of the Phase 0 runtime role

Challenge the following:

**A. Public TRUNCATE allowlist**

* Is `PUBLIC_TRUNCATE_TABLES` actually the list consumed by `setup-db.ts`?  
* Does it contain only existing P1/P3 public-schema tables?  
* Is `p2_probe_log` absent?  
* Are there other entries that refer to missing relations?  
* Is an exact-set regression assertion present, or could an unexpected table be added without failing the test?  
* Are table names safely quoted when constructing SQL?

**B. Inventory**

* Does `PROTOTYPE_INVENTORY_SCHEMAS` include both `public` and `app`?  
* Does the actual inventory query consume that constant?  
* Does inventory accurately identify P1/P2/P3 relations without confusing similarly named objects in other schemas?  
* Does the change preserve ownership snapshots?

**C. Runtime privileges**

* Is the decision not to grant additional `app` privileges to `phase0_rt` supported by actual consumer inspection?  
* Could a local test or worker require those permissions indirectly?  
* Has the remediation avoided replacing the missing-table error with unnecessarily broad grants?

**D. Ownership and teardown**

* Do both provisioners preserve schema-qualified identities?  
* Can an object under `app` be confused with an object of the same name under `public`?  
* Can teardown remove an object that was not created or owned by the current execution?  
* Does the fix leave ownership-ledger behavior and cleanup semantics intact?

**Required regression proof:**

The new contract test must demonstrably reject the original defective allowlist containing `p2_probe_log`.

Do not accept a test that merely searches the source code for a literal substring which the original dynamically constructed SQL never contained.

Verdict this section independently.

## **3\. Review B — role creation, DBOS migration, and connection boundaries**

Original defect:

`applyStagingSetup()` called `DBOS.migrate()` with `applicationRole` before creating that role. It also attempted role creation through the application connection.

Expected corrected sequence:

1. Create the `NOLOGIN` runtime role using `ownSys`.  
2. Run DBOS migration using the system connection and the runtime role.  
3. Apply P2 application schema.  
4. Apply P3 application schema.  
5. Grant database CONNECT through the system connection.  
6. Apply application-schema DML and sequence grants through the application connection.  
7. Verify inventory and effective privileges.

Inspect:

* `phase0/p2/setup-staging.mjs`  
* `phase0/p2/setup-staging.test.ts`  
* `phase0/p2/verify-staging-apply.mjs`  
* `phase0/p2/schema.sql`  
* `phase0/p3/schema.sql`  
* The DBOS SDK migration and grant behavior actually used by the installed dependency version

Challenge the following:

**A. Operation ordering**

* Does role creation genuinely happen before every DBOS operation that grants privileges to that role?  
* Is the operation performed on `ownSys`?  
* Is there another DBOS migration or grant path elsewhere that assumes the role already exists?  
* Does the source-order regression test inspect the actual `applyStagingSetup()` implementation rather than an unrelated helper or comment?

**B. Connection responsibility**

* Is role creation performed through the system connection and not `ownApp`?  
* Are database-level grants performed using the intended system connection?  
* Are application-schema grants performed using the intended application connection?  
* Could the application connection be inadvertently required to have elevated role-management privileges?  
* Are system and application database URLs still validated and kept distinct in their intended responsibilities?

Important limitation:

The current CI job uses the same privileged PostgreSQL credentials for both URLs. Consequently, a successful live CI test using those credentials does not prove the privilege boundary. Do not claim that it does.

**C. Least privilege**

* Does the role remain `NOLOGIN`?  
* Has superuser, ownership, CREATE, or other unnecessary privilege been introduced?  
* Are grants restricted to the tables, sequences, and schema the worker actually needs?  
* Are DBOS grants still applied through the supported SDK mechanism?  
* Does role creation remain idempotent?  
* Does the duplicate-role handling have any race or failure scenario that could conceal an actual setup failure?

**D. Re-application and effective privileges**

Inspect the actual live test, not merely the helper code.

Verify that it:

* Applies staging setup twice.  
* Preserves a pre-existing sentinel row.  
* Verifies the expected tables.  
* Verifies P3 function and trigger installation.  
* Executes real DML while acting as the runtime role.  
* Rolls back its probe data.  
* Verifies no residual probe data remains.  
* Does not pass without executing the intended assertions.

**Required regression proof:**

The new test must fail against the original implementation for both incorrect ordering and incorrect connection target.

The existing live double-application test must still exercise the real `applyStagingSetup()` path.

## **4\. Review C — Bash error handling and packaging test**

Original defect:

The workflow used an expected nonzero command followed by `test $? -eq 2`. Under Actions' Bash `-e`, the shell exited before the assertion could execute.

Expected correction:

```
status=0
docker run --rm -e ROLE=bogus p2staging:ci node phase0/p2/probe-web.mjs || status=$?
test "$status" -eq 2
```

Inspect:

* `.github/workflows/phase0.yml`  
* `phase0/p2/packaging.test.ts`  
* `phase0/p2/probe-web.mjs`  
* `phase0/p2/Dockerfile.p2staging`

Challenge the following:

* Does the workflow initialize the status variable before invoking the negative test?  
* Does `|| status=$?` capture the actual failing command's exit code?  
* Does `bash -e` remain enabled?  
* Does an unexpected exit code of zero fail the test?  
* Does exit code one fail?  
* Does exactly exit code two pass?  
* Is the application's invalid-role refusal behavior unchanged?  
* Does the regression test inspect the actual workflow step and fail against the former implementation?  
* Does the smoke test run inside the production-only Docker image?  
* Has the image's production dependency set or entry chain been weakened to get the test green?

Do not accept simply removing `-e`, appending `|| true`, or changing the application to return zero.

## **5\. Cross-cutting regression review**

Review the entire change for unintended consequences.

Pay particular attention to:

* P1 atomic enqueue and worker behavior.  
* P3 wallet/provider safety and reconciliation.  
* Backpressure tests.  
* Vault known-failure baseline.  
* Ownership ledger and cleanup guarantees.  
* DBOS system/application database separation.  
* Existing staging safety checks.  
* Production-only dependency packaging.  
* CI workflow job coverage.  
* SQL schema placement and privilege scope.

The remediation should not introduce:

* A new migration architecture.  
* A new queue or orchestration subsystem.  
* Broad database grants.  
* A custom locking mechanism.  
* New cloud infrastructure.  
* Local development requirements that the owner explicitly does not have.  
* Changes unrelated to the three failures.

Do not recommend architectural expansion without identifying a concrete defect in the current implementation.

## **6\. Test integrity and evidence**

Independently inspect the new tests.

A test is not meaningful merely because it passes. For each regression test, establish:

1. Which original defective behavior it detects.  
2. Why the original implementation would fail it.  
3. Why the corrected implementation passes it.  
4. Whether it could pass vacuously because its target code or assertion was never executed.  
5. Whether it is testing the real implementation or just a textual approximation.

Where practical, reproduce pre-fix failure in a temporary isolated copy or via a safe, reversible test technique. Do not modify the working branch to demonstrate failure.

Inspect the test commands and actual output.

Reported local evidence:

* `npm run test:phase0:unit`: 17 files, 277 tests passed.  
* `npm run typecheck`: passed.  
* `npx tsc -p phase0/tsconfig.json --noEmit`: passed.

Verify these results when the environment is available.

Do not ask the owner to install Docker. Do not attempt local Docker tests if Docker is unavailable.

Do not access `.env`, request secrets, connect to Fly or Neon, or perform staging/production operations.

## **7\. GitHub Actions verification**

If the changes have been published and a new Actions run exists, inspect the actual run and job logs.

Required Docker-backed gates:

* `integration`  
* `p2-boot-proof`  
* `p2-packaging`

Also verify:

* `unit`  
* `typecheck`  
* `app-suite`  
* Any other required Phase 0 jobs present in the workflow.

Do not confuse the old failed run 43719980758 with a post-fix validation run.

If a new run is unavailable, explicitly state that Docker-backed validation remains unverified.

Do not infer success from green local unit tests, a successful image build that was not actually run, or static inspection.

## **8\. Findings format**

Report findings in this order:

### **Executive verdict**

Choose exactly one:

* **APPROVE** — no blocking or material defects found; required evidence supports the fix.  
* **APPROVE WITH NONBLOCKING FINDINGS** — no correctness blocker, but minor issues remain.  
* **FIX BEFORE MERGE** — one or more material correctness, security, regression, or evidence defects remain.  
* **INSUFFICIENT EVIDENCE** — the available code or validation does not support a reliable verdict.

### **Findings**

For every finding provide:

* Finding ID.  
* Severity: CRITICAL / HIGH / MEDIUM / LOW / INFORMATIONAL.  
* Exact file and line range.  
* Actual observed behavior.  
* Why it is a defect or risk.  
* A concrete reproduction or failure scenario.  
* Why existing tests do not catch it.  
* The smallest technically correct remediation.

Do not invent findings. If a concern is only hypothetical and cannot be tied to a concrete execution path, label it informational or omit it.

### **Verification matrix**

Report each gate as:

* PASS — directly verified.  
* FAIL — reproduced failure.  
* NOT RUN — unavailable or not executed.  
* INSUFFICIENT — evidence does not establish the claim.

Separate local verification from GitHub Actions verification.

### **Scope and regression assessment**

State explicitly whether:

* P1 was preserved.  
* P3 was preserved.  
* Backpressure was preserved.  
* Vault baseline was preserved.  
* Ownership and teardown guarantees were preserved.  
* The system/application connection boundary was preserved.  
* Application fail-closed behavior was preserved.

### **Final recommendation**

State whether the PR should be merged, requires targeted remediation, or must wait for additional CI evidence.

Do not soften a material finding to make the PR appear acceptable.

## **9\. Hard boundaries**

This is a REVIEW ONLY assignment.

* Do not edit files.  
* Do not generate replacement implementations.  
* Do not commit or push.  
* Do not merge or deploy.  
* Do not mutate GitHub resources.  
* Do not connect to Fly or Neon.  
* Do not request or inspect secrets.  
* Do not access `.env`.  
* Do not install Docker.  
* Do not expand the task beyond the P2 CI remediation.

Your objective is to determine whether the three fixes genuinely eliminate their root causes without introducing new defects or weakening existing safety guarantees.

**My recommendation:** run this review against the complete working diff, including untracked files, before publication. After publication, have the reviewer separately inspect the new GitHub Actions run. A clean code review and a green CI run are two distinct acceptance gates.

