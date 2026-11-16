I inspected workflow run **43719980758**. It has three failing jobs, and all three failures are reproducible code or test-harness problems—not a Docker build failure or a Fly/Neon connectivity issue.

Passed `app-suite`, `typecheck`, and `unit`.

Failed `integration`, `p2-boot-proof`, and `p2-packaging`.

The most important finding is that the P2 packaging test successfully builds the production image and imports its TypeScript modules. It fails afterward because the negative test expects the wrong exit code. The integration failure is separate: the shared database setup script still references a legacy table in the `public` schema.

## **Exact failures and root causes**

### **1\. `integration` — stale setup script reference**

The integration test successfully starts PostgreSQL, verifies the disposable database, applies P1/P2/P3 schemas, and creates `phase0_rt`.

It then fails here:

```
error: relation "public.p2_probe_log" does not exist
code: 42P01
at phase0/setup-db.ts:106
```

The current P2 staging schema creates its tables under `app`, not `public`. However, `phase0/setup-db.ts` still grants privileges against a hard-coded list of tables in `public`, including `p2_probe_log`.

**Root cause:** the legacy integration setup was not updated to reflect the new P2 schema placement. This is a genuine compatibility defect, not a transient database issue.

The fix should preserve the isolation contract: the local Phase 0 test harness must continue using its intended schema and table layout. Do not blindly move the P2 staging schema into `public` just to make this test pass.

### **2\. `p2-boot-proof` — runtime role created too late**

The first T1-positive worker proof passes. The worker initializes, becomes ready, and shuts down cleanly.

The next staging-apply verification fails:

```
Failed to grant permissions to role p2ci_worker:
role "p2ci_worker" does not exist

at phase0/p2/setup-staging.mjs:194
```

The ordering in `applyStagingSetup()` is the problem:

1. `DBOS.migrate(... applicationRole: appRole ...)` runs first.  
2. Only afterward does `createRoleStatement(appRole)` execute.

DBOS attempts to grant permissions to `p2ci_worker` before that role exists.

**Root cause:** the role-creation operation is ordered after the operation that depends on it. The role must exist before DBOS migration attempts to grant its privileges.

The correction must retain the intended `NOLOGIN` role and the distinct system/application database connection responsibilities. Do not solve this by granting the CI worker superuser or weakening the privilege checks.

### **3\. `p2-packaging` — the negative test itself fails under Bash strict mode**

The actual image builds successfully. Its TypeScript imports also succeed:

```
ts+probe-config OK p2
generations OK
staging-provider OK
```

The final test runs:

```
docker run --rm -e ROLE=bogus p2staging:ci node phase0/p2/probe-web.mjs; test $? -eq 2
```

The program correctly refuses the invalid role:

```
FATAL: probe-web.mjs requires ROLE=web, got: bogus
```

It exits with code `2`. But because the GitHub Actions shell uses `bash -e`, Bash terminates the script immediately on that expected nonzero exit. The subsequent `test $? -eq 2` is never executed.

**Root cause:** the test does not safely capture an expected failure under `bash -e`.

Use an explicit conditional or another safe exit-status capture pattern. Do not change the program to return zero for invalid roles.

### **Important distinction: the integration and staging schemas**

The `phase0/p2/schema.sql` header explicitly says its tables belong in `app`, and `phase0/setup-db.ts` nevertheless lists `p2_probe_log` in its legacy `public`\-schema TRUNCATE grants.

That mismatch explains the first failure. The remediation needs to inspect the P2 integration tests and ownership/teardown code before changing the grants. The correct fix may require moving only the P2 proof references to `app`, while leaving P1/P3 local test fixtures and their existing `public`\-schema assumptions intact.

## **Remediation prompt for your coding agent**

Use this prompt against the current PR branch. It is deliberately narrow and requires the agent to inspect the existing implementation before editing.

# **P2 CI Failure Remediation — Run 43719980758**

You are working on `PithomLabs/openlevel`, branch `phase0/p2-staging-readiness`, PR \#2.

Your task is to remediate the three actual CI failures from:

[https\://github.com/PithomLabs/openlevel/actions/runs/43719980758](https://github.com/PithomLabs/openlevel/actions/runs/43719980758)

Do not broaden the architecture or introduce new infrastructure.

## **1\. Verified CI results**

Passed:

* `app-suite`  
* `typecheck`  
* `unit`  
* P2 T1-positive boot proof  
* Docker staging image build  
* Production-dependency TypeScript import smoke test

Failed:

### **A. integration**

Exact failure:

`error: relation "public.p2_probe_log" does not exist`

PostgreSQL error code: `42P01`

Location: `phase0/setup-db.ts:106`

The setup script applies `phase0/p2/schema.sql`, which explicitly creates P2 tables under the `app` schema. But the legacy local setup still includes `p2_probe_log` in a hard-coded `public`\-schema TRUNCATE grant list.

Inspect all consumers of P2 tables in:

* `phase0/setup-db.ts`  
* `phase0/p2/schema.sql`  
* P2 integration tests  
* `phase0/provisioners/ownership.ts`  
* Native and Testcontainers provisioner teardown paths

Determine the correct local/CI schema contract. Do not blindly move P2 tables into `public`, and do not break the staging `app` schema contract.

Correct the root cause and ensure:

* The setup script no longer grants privileges against nonexistent relations.  
* P2 test and teardown code uses the correct schema.  
* Existing P1/P3 integration tests retain their intended behavior.  
* Ownership tracking still records and cleans only objects actually owned by the test execution.  
* The test remains safe to re-run.

Add or update regression tests proving the local/CI and staging schema contracts do not get conflated.

### **B. p2-boot-proof**

The T1-positive worker proof succeeds, including readiness and graceful SIGTERM shutdown.

The staging-apply verification fails:

`role "p2ci_worker" does not exist`

Location: `phase0/p2/setup-staging.mjs`, in `applyStagingSetup()`.

Current ordering:

1. `DBOS.migrate(sysUrl, { schemaName: 'dbos', applicationRole: appRole })`  
2. `createRoleStatement(appRole)`  
3. Apply CONNECT and application-schema grants.

DBOS attempts to grant privileges to the runtime role before the role exists.

Correct the operation ordering so the required NOLOGIN role exists before DBOS migration attempts to grant its privileges.

Preserve:

* The NOLOGIN role design.  
* The separate system and application DB connections.  
* The intended DBOS schema grants.  
* Application-schema least-privilege grants.  
* Idempotency across repeated setup.  
* The live CI proof that tests effective privileges by acting as the runtime role, not just inspecting catalog rows.

Do not grant superuser, broad ownership, or unnecessary CREATE privileges to make the test pass.

Add a regression test that would fail under the previous ordering and proves the actual `applyStagingSetup()` path succeeds twice.

### **C. p2-packaging**

The Docker image builds successfully. The production-only dependencies and TypeScript module imports also work.

The final negative smoke test fails because GitHub Actions executes the script under Bash `-e`.

Current line:

`docker run --rm -e ROLE=bogus p2staging:ci node phase0/p2/probe-web.mjs; test $? -eq 2`

The program correctly prints:

`FATAL: probe-web.mjs requires ROLE=web, got: bogus`

It exits with code 2, but Bash `-e` terminates the step before the subsequent `test` command runs.

Fix the test to capture and assert the expected nonzero exit status safely under `bash -e`.

Do not change the application to return success for an invalid role. Preserve the fail-closed behavior.

Also ensure the smoke test fails if the invalid-role invocation unexpectedly returns zero.

## **2\. Required validation**

Run and report the actual results of:

1. `npm run test:phase0:unit`  
2. `npm run typecheck`  
3. `npx tsc -p phase0/tsconfig.json --noEmit`  
4. `npm run test:phase0:integration`  
5. The P2 staging-apply proof against disposable PostgreSQL, including first application, effective runtime-role DML, and idempotent second application.  
6. The P2 ledger-race proof.  
7. The production-only Docker build and all image smoke tests on GitHub Actions.

The Mac does not have Docker. Do not ask the owner to install Docker or attempt a local Docker test. Use GitHub Actions for Docker-backed validation.

Do not access `.env`, request secrets, connect to Fly, connect to Neon, or run staging/production operations. The staging-apply proof must use only the disposable CI PostgreSQL service.

Do not change P1, backpressure, the vault baseline, or unrelated P3 behavior without showing direct evidence that a change is necessary.

## **3\. Adversarial review requirements**

Before declaring completion, independently challenge your fixes:

* Can setup still fail because any P2 table is referenced under the wrong schema?  
* Can teardown accidentally delete or truncate an object it did not create?  
* Does the runtime role exist before every DBOS privilege grant?  
* Does repeated setup preserve existing data?  
* Are grants actually effective when operating as the runtime role?  
* Does the invalid-role smoke test prove exit code 2 without disabling Bash error handling?  
* Can any test pass without executing its intended assertion?

Fix root causes, not symptoms.

## **4\. Reporting and Git boundaries**

Provide:

* Root cause for each failure.  
* Exact changed files and rationale.  
* Regression tests added or updated.  
* Exact commands run and their results.  
* Any unresolved issues and their severity.

Do not commit, push, merge, deploy, or mutate GitHub resources. The owner handles Git publication manually.

Do not claim CI is green until a new GitHub Actions run verifies all required jobs.

## **Recommended next step**

Have the agent implement these three fixes and report the changed files and local non-Docker validation. Then publish the changes manually and inspect the next Actions run.

**Do not rerun the failed workflow as-is.** It will reproduce the same deterministic failures. Also, do not proceed to Fly/Neon staging T1–T6 yet; the current run has not established the required CI acceptance gates.

