# **Independent Adversarial Re-Review — OpenLevel Remediation After Review 9**

## **Role**

Act as an independent senior engineer conducting a fresh adversarial code review of the OpenLevel cross-platform Taskfile and local-development tooling.

The previous review, `adv_review9(3).md`, returned **REJECT** with one P1 and four P2 findings.

The implementation agent has completed a remediation pass under Prompt31 and reports that all five findings are fixed. Its recommendation is **READY FOR RE-REVIEW**.

Your responsibility is to independently determine whether that claim is justified.

Do not trust the implementation summary, test counts, or claimed fixes without inspecting the source and reproducing the evidence. The previous reviewer must not become the authority for the new implementation merely because the new report says the findings are resolved.

This is a fresh acceptance review, not a code-authoring task.

## **1\. Sources and review baseline**

Read these materials first:

* `adv_review9(3).md` — original adversarial findings and rejection rationale.  
* `docs/development/LOCAL_DEVELOPMENT.md` — current local-development contract.  
* `docs/development/TOOLCHAIN_COMPATIBILITY.md` — toolchain and host compatibility policy.  
* `Taskfile.yml`  
* `scripts/dev.mjs`  
* `scripts/lib/dev-env.mjs`  
* `scripts/lib/dev-env.d.mts`  
* `scripts/lib/dev-env.test.ts`  
* `scripts/taskfile-contracts.test.ts`  
* `scripts/dev-rejection.test.ts`  
* `scripts/toolchain.mjs`  
* `server/dev-server.ts`  
* `vite.config.ts`

Inspect any additional supporting files, configuration, or tests required to understand the actual execution paths.

The remediation report claims the following:

### **Implementation changes**

New files:

* `scripts/lib/dev-env.mjs`  
* `scripts/lib/dev-env.d.mts`  
* `scripts/lib/dev-env.test.ts`  
* `scripts/taskfile-contracts.test.ts`  
* `scripts/dev-rejection.test.ts`

Edited files:

* `scripts/dev.mjs`  
* `scripts/toolchain.mjs`  
* `server/dev-server.ts`  
* `vite.config.ts`  
* `Taskfile.yml`  
* `docs/development/LOCAL_DEVELOPMENT.md`

The new `dev-env.mjs` is intended to provide a single validated configuration source through:

* `resolveDevConfig`  
* `proxyTargetFor`  
* `classifyBindError`  
* `describeBindFailure`

The remediation report specifically claims:

* API port overrides now propagate from Taskfile through launcher, API server, Vite proxy, and health probes.  
* Bind-error classification is shared by the launcher and doctor.  
* The Vite proxy uses an explicit loopback target, with IPv6 URL construction handled correctly.  
* Fly and Neon variables are passed through Taskfile environment blocks and quoted shell expansions.  
* The loopback allowlist is enforced before launch and in both individual development servers.  
* The Vite build path was left unchanged.  
* The production server was not modified.

### **Reported verification**

The agent reports:

* Focused tests: 66/66 PASS.  
* Validator checks: ALL PASS.  
* Root and Phase 0 typechecks: PASS.  
* Phase 0 unit suite: 284/284 PASS.  
* Main suite: 1655 passed plus exactly one pinned vault baseline failure.  
* Build: PASS.  
* Live `task dev`: BLOCKED because sandbox socket operations return `EPERM`.  
* Docker suites: NOT RUN because Docker is unavailable.  
* The live-development fail-closed path was tested instead.  
* IPv6 end-to-end, Linux/`ss` parsing, and browser proof remain unverified.

Treat these as claims, not evidence. Reproduce whatever is safely possible.

## **2\. Non-negotiable review boundaries**

This is a read-only review.

1. Do not modify, format, rewrite, generate, delete, or repair repository files.  
2. Do not commit, push, merge, deploy, or change branches.  
3. Do not install or upgrade workstation software.  
4. Do not authenticate to Fly, Neon, or any external service.  
5. Do not create or mutate cloud resources or remote databases.  
6. Do not start, stop, migrate, seed, reset, or delete a real database.  
7. Never inspect, print, copy, or expose `.env` or other secret-bearing files. Checking whether a file exists is permitted.  
8. Do not run destructive commands to test safety guards.  
9. Preserve the existing working tree, including untracked files.  
10. Do not claim a check passed unless you personally executed it and observed the result.  
11. Clearly distinguish `PASS`, `FAIL`, `NOT RUN`, and `BLOCKED`.  
12. Do not ask the owner to install Docker or other tools to make the review pass.

Do not repair defects during this review. Identify them and recommend the smallest appropriate correction.

## **3\. Establish the actual remediation diff**

Before judging the fixes:

* Record the current branch, commit, tracked changes, and untracked files.  
* Identify the exact files changed since the original review.  
* Compare the current implementation with the original reviewed snapshot where possible.  
* Verify that the five intended fixes are present.  
* Check for unrelated changes or accidental removal of existing work.  
* Verify that the pre-existing `CLAUDE.md` worktree deletion remains exactly as it was and was not silently restored or altered.  
* Confirm that `P3-1` through `P3-4` were not expanded into an unrelated redesign.

Pay particular attention to the new helper and declaration file. Confirm that actual runtime imports resolve correctly in the repository's Node/TypeScript execution environment.

Check that `.d.mts` is appropriate for the `.mjs` module and that the type declaration accurately describes the exported functions. Do not accept a typecheck pass as sufficient proof that runtime and type declarations agree.

## **4\. Re-review P1-1 — API port override end-to-end**

Original finding: `task dev API_PORT=8899` was accepted by the launcher but ignored by the actual API server and Vite proxy. The launcher then waited on the wrong health-check port.

The new implementation claims to resolve configuration centrally through `resolveDevConfig`.

Independently trace the complete data flow:

`Taskfile CLI variable`  
→ `Taskfile environment`  
→ `scripts/dev.mjs`  
→ API child environment  
→ `server/dev-server.ts`  
→ actual API bind address and port

Separately trace:

`Taskfile CLI variable`  
→ `Taskfile environment`  
→ Vite child environment  
→ `vite.config.ts`  
→ actual proxy target

And:

`Taskfile CLI variable`  
→ launcher health probe  
→ actual API health endpoint

### **Required verification**

Verify the defaults:

* API: `8790`  
* Web: `5273`  
* Host: `127.0.0.1`

Verify representative overrides:

* `API_PORT=8899`  
* `WEB_PORT=5280`  
* Both overrides together.  
* Explicit defaults supplied as CLI overrides.  
* Invalid ports and empty values.

Check the following tasks individually:

* `dev`  
* `dev:api`  
* `dev:web`  
* `dev:health`  
* `dev:open`

For every task, establish whether the effective values are identical and whether the task can be invoked independently without losing configuration.

Inspect Taskfile global-variable resolution and nested task environment propagation. Verify that explicit command-line values take precedence over defaults.

Inspect how the API server reads and validates its environment. Confirm validation happens before PGlite initialization or any server side effect.

Inspect how Vite resolves configuration for development versus build. Confirm that:

* The serve configuration receives the intended runtime values.  
* The development proxy target matches the API listener.  
* `strictPort` and host behavior are correct.  
* Build configuration remains unchanged in behavior.  
* A build does not accidentally inherit local development host or port configuration.

A particularly important check is whether the new helper is truly the single source of configuration or whether hardcoded ports, duplicated parsing, or alternate environment-variable names remain elsewhere.

**Acceptance condition:** No documented API or web override can be silently ignored. The listener, proxy, health probe, printed URLs, and standalone tasks must agree.

A mocked or unit-tested configuration flow is useful evidence, but it does not prove that a live API and Vite process communicate correctly. State this distinction explicitly.

## **5\. Re-review P2-1 — Bind-error classification**

The new shared helper provides `classifyBindError` and `describeBindFailure`.

Verify the classification independently.

Expected behavior:

* `EADDRINUSE`: actual occupied address/port; process-owner investigation may be suggested.  
* `EPERM`: operation denied; never describe it as proof of port occupation.  
* `EACCES`: permission denied; never describe it as proof of port occupation.  
* `EADDRNOTAVAIL`: requested address unavailable; explain the address problem.  
* Unknown error: report a generic bind/probe failure with useful error context.

Check:

* The classifier handles Node errors and unexpected error shapes safely.  
* Missing `code` values do not accidentally become occupied-port errors.  
* Case or type assumptions cannot produce incorrect messages.  
* The launcher and doctor use the same classification semantics.  
* No remaining duplicate classifier contradicts the shared helper.  
* Process-owner diagnostics remain best-effort.  
* Missing `lsof` or `ss` never causes a failed bind probe to be reported as success.  
* Error messages do not recommend killing processes for anything other than `EADDRINUSE`.

Inspect both unit coverage and the actual caller behavior. A correct helper is insufficient if a caller ignores its result or maps errors incorrectly.

**Acceptance condition:** Only genuine `EADDRINUSE` conditions are diagnosed as an occupied port.

## **6\. Re-review P2-2 — Vite proxy and loopback address consistency**

The previous implementation used `localhost` for the Vite proxy while the API was bound to `127.0.0.1`.

The new implementation claims to use `proxyTargetFor` to construct a target consistent with the API listener.

Verify:

* Default proxy target is exactly `http://127.0.0.1:<api-port>`.  
* Custom API ports change the proxy target.  
* IPv6 loopback generates a syntactically valid bracketed URL.  
* `localhost` normalizes consistently to the canonical supported address.  
* The API listener and proxy target use the same normalized host.  
* No accidental wildcard, public, or external proxy address is possible.  
* The helper does not produce double brackets, malformed URLs, or incorrect port placement.  
* Vite does not resolve or reinterpret the configured target in a way that breaks the intended loopback behavior.

Inspect whether the proxy target is generated once from the validated configuration or reconstructed independently in multiple locations.

Review the serve-only Vite configuration carefully. Verify that the function-form configuration correctly differentiates development serving from production builds.

**Acceptance condition:** The proxy target and API listener must use the same canonical loopback address and effective API port.

The report admits that IPv6 end-to-end remains unverified. Do not present unit tests or URL construction as proof of a functioning IPv6 API-to-proxy connection.

## **7\. Re-review P2-3 — Fly and Neon shell argument safety**

The original finding involved shell interpolation of `FLY_APP` and `FLY_CONFIG`.

The remediation claims that Fly and Neon values, including confirmation variables, now pass through Taskfile `env:` blocks and quoted `"$VAR"` expansions in both commands and preconditions.

Inspect every Fly and Neon task, not just the deploy command.

Verify:

* There are no remaining unsafe template interpolations in shell command source.  
* All user-controlled arguments are passed as distinct arguments.  
* Empty and unset variables are handled correctly.  
* Quoting survives nested task calls.  
* Preconditions inspect the intended values.  
* A command cannot be injected through app names, configuration paths, project IDs, branch IDs, or confirmation values.  
* Read-only tasks remain read-only.  
* The deploy guard still requires all previously established conditions.  
* P2 staging configuration and application rejection remain effective.  
* No command authenticates, deploys, or mutates resources during verification.

Use harmless argument-capturing stubs if available. Test values containing spaces, quotation marks, shell metacharacters, and command-substitution syntax.

Inspect the stub tests carefully. Verify they prove actual argv boundaries and do not merely check the appearance of quoted YAML text.

**Acceptance condition:** Every user-controlled argument reaches the executable as the intended single argument, with no shell injection path, and all existing Fly/Neon safety guards remain intact.

## **8\. Re-review P2-4 — Loopback-only enforcement**

The remediation claims that `resolveDevConfig` accepts only:

* `127.0.0.1`  
* `::1`  
* `localhost`, normalized consistently

The check is claimed to occur before launch and in both individual development servers.

Verify the actual enforcement paths.

Specifically inspect:

* `task dev`  
* `task dev:api`  
* `task dev:web`  
* Direct `node scripts/dev.mjs` invocation  
* Direct API development-server invocation  
* Direct Vite invocation  
* Environment-variable overrides  
* Nested Taskfile calls

Try to identify any alternate route that bypasses the validator.

Verify that the following are refused:

* `0.0.0.0`  
* `::`  
* Arbitrary IPv4 addresses  
* Arbitrary IPv6 addresses  
* External hostnames  
* Malformed host values  
* Whitespace or alternate representations that normalize unexpectedly

Confirm that `localhost` becomes a consistent canonical address rather than resolving differently for the API and Vite.

Check that validation happens before either server begins listening and before any unrelated startup side effect.

**Acceptance condition:** Neither the full development session nor an individual development server can bind to a non-loopback interface through supported command or environment inputs.

## **9\. Adversarially inspect the new helper and tests**

Do not limit the review to the five original symptoms.

The new shared module creates a central point of correctness. Inspect it for:

* Environment-variable precedence mistakes.  
* Incorrect numeric port parsing.  
* Invalid, fractional, zero, negative, oversized, or nonnumeric port acceptance.  
* `NaN` or empty-string propagation.  
* IPv6 normalization defects.  
* Host allowlist bypasses.  
* Incorrect URL construction.  
* Inconsistent defaults across callers.  
* Type/runtime declaration disagreement.  
* Unhandled exceptions and misleading fallbacks.  
* Import-resolution problems across Node, TypeScript, Vitest, Task, and Vite.

Review all newly added tests for quality:

* Are assertions testing behavior rather than source-code spelling?  
* Do tests exercise realistic input values?  
* Are important negative cases included?  
* Do tests fail against the original defective implementation?  
* Are mocks concealing a broken integration boundary?  
* Are assertions too permissive?  
* Are tests accidentally dependent on the review host?  
* Are any tests weakened, skipped, or over-mocked to obtain a green result?

The report says 15 tests failed before the fixes and a 16th exposed an IPv6 proxy bug that was subsequently repaired. Determine whether this represents genuine regression-sensitive coverage or merely a test suite that has been written around the current implementation.

Do not assume that 66 passing tests imply all five defects are fixed.

## **10\. Regression review of preserved behavior**

Confirm that remediation did not damage previously correct behavior.

In particular:

* Task 3.54 global-variable resolution still works.  
* CLI overrides are not shadowed by task-level defaults.  
* Process-group termination and sibling cleanup remain bounded and correct.  
* The launcher does not leave orphaned processes.  
* HTTP readiness checks remain genuine and bounded.  
* `NO_BROWSER=1` remains effective.  
* The PostgreSQL URL guard remains unchanged and fail-closed.  
* IPv6 bracket stripping for `psql -h` remains correct.  
* PostgreSQL major-version safeguards remain intact.  
* Fly and Neon operations remain owner-controlled.  
* Node 22 remains the project runtime.  
* `package.json`, `.nvmrc`, lockfile, and CI runtime pins remain consistent.  
* PGlite development remains independent of native PostgreSQL and Docker.  
* No product deployment configuration has been introduced accidentally.  
* No production-server behavior has been changed to solve local-development issues.

Compare the actual diff rather than trusting the summary.

## **11\. Deferred issues — verify scope discipline**

The previous review explicitly deferred these items:

* **P3-1:** `task check` and the pinned vault baseline failure.  
* **P3-2:** Doctor's hardcoded default ports.  
* **P3-3:** Minimum Task version declaration.  
* **P3-4:** Direct `npm run migrate` / `npm run seed` database-guard bypass.  
* **Unrelated `CLAUDE.md` worktree deletion:** preserved for owner disposition.

Confirm these were not silently redesigned or partially changed in ways that introduce regressions.

Do not expand this review into fixing them. Record any new material risk separately if the remediation introduced one.

## **12\. Independent verification**

Run all safe checks that the current environment supports.

At minimum, attempt:

1. Taskfile parsing and task listing.  
2. Focused new helper and contract tests.  
3. Existing launcher rejection tests.  
4. Root typecheck.  
5. Phase 0 typecheck.  
6. Phase 0 unit tests.  
7. Main unit suite.  
8. Build.  
9. Fly/Neon argument-safety tests using harmless stubs.  
10. Database guard regression checks.  
11. Toolchain doctor and bind-error behavior.  
12. Relevant Taskfile dry runs that cannot trigger installation, authentication, or mutation.

Inspect exact test output rather than relying on a summary from a previous session.

### **Main suite baseline**

The remediation reports 1655 passed and exactly one pinned vault failure.

Verify that the failing test genuinely matches the established baseline by checking the precise file, test name, and baseline record.

Do not accept "one failure" as sufficient proof. A different failure, or an additional failure hidden by the summary, must be reported.

### **Live development and proxy proof**

Attempt a real `task dev` run only if the environment permits local listening sockets.

If permitted, test:

* Default API and web ports.  
* A non-default API port.  
* A non-default web port.  
* Both overrides together.  
* An actual HTTP request through the Vite `/api` proxy.  
* Ctrl+C cleanup and absence of orphaned processes.

If the sandbox denies `listen()` with `EPERM`, mark live tests `BLOCKED` or `NOT RUN` and provide the observed evidence.

Do not claim that the end-to-end workflow passed because unit tests and child fail-fast probes passed.

### **IPv6 and Linux**

The report identifies these as unverified.

Do not claim:

* IPv6 end-to-end works based only on URL construction or unit tests.  
* Linux works based only on static inspection.  
* Linux `ss` parsing works without an actual representative runtime.

If no suitable host is available, preserve the `NOT RUN` status and describe what evidence would still be needed.

Do not ask the owner to install Docker.

## **13\. Required final review report**

Begin with one verdict:

* **APPROVE** — all five original findings are independently verified as fixed, no material new defects remain, and the implementation is safe to accept within the evidence available.  
* **APPROVE WITH FINDINGS** — all five rejection findings are fixed, but specific non-blocking issues or environmental proof gaps remain.  
* **REJECT** — one or more original findings remain unresolved, a regression has been introduced, or a material safety/correctness defect exists.

Do not use **READY FOR RE-REVIEW** as the verdict. This is the re-review itself; make the independent acceptance decision.

### **A. Executive verdict**

State the verdict and the strongest supporting reason. Do not praise the implementation or merely repeat the author's report.

### **B. Original finding disposition**

For each of the five original findings, report:

| Finding | Verdict | Evidence |
| ----- | ----- | ----- |
| P1-1 — API port override | FIXED / NOT FIXED | Concrete source and test evidence |
| P2-1 — Bind-error classification | FIXED / NOT FIXED | Concrete source and test evidence |
| P2-2 — Vite proxy target | FIXED / NOT FIXED | Concrete source and test evidence |
| P2-3 — Fly/Neon shell safety | FIXED / NOT FIXED | Concrete source and test evidence |
| P2-4 — Loopback enforcement | FIXED / NOT FIXED | Concrete source and test evidence |

A finding is not fixed merely because a test bearing its name passes. Explain the behavior that establishes the fix.

### **C. New findings**

Order all new findings by severity:

* P0 — Critical  
* P1 — High  
* P2 — Medium  
* P3 — Low

For each finding, include:

* Exact file and line/function.  
* Concrete defect and impact.  
* Reproduction or failure scenario.  
* Why existing tests did not catch it.  
* Smallest appropriate correction.  
* Whether introduced by this remediation or pre-existing.

Do not invent speculative findings to make the review appear adversarial.

### **D. Verification record**

List the exact commands executed, exit statuses, and results:

* `PASS`  
* `FAIL`  
* `NOT RUN`  
* `BLOCKED`

Distinguish checks executed in this re-review from results documented by the implementation agent.

### **E. Scope and regression assessment**

Report:

* Unexpected or unrelated changes.  
* Whether the deferred P3 items remain deferred.  
* Whether `CLAUDE.md` remains preserved.  
* Whether the established safety boundaries remain intact.  
* Whether the production and build paths were preserved.

### **F. Portability and evidence limitations**

State separately what is demonstrated on the actual review host and what remains unverified.

Explicitly address:

* Live development startup.  
* Actual Vite-to-API proxy request.  
* IPv6 end-to-end.  
* Linux runtime.  
* Linux `ss` parsing.  
* Browser proof.  
* Docker-backed tests.

Do not use static inspection as a substitute for runtime evidence.

### **G. Final acceptance decision**

Answer explicitly:

1. Is API port configuration truly consistent across Taskfile, launcher, API, Vite, health checks, and standalone tasks?  
2. Can any bind error other than `EADDRINUSE` be misreported as a port conflict?  
3. Does the Vite proxy target the exact canonical API loopback address?  
4. Are Fly and Neon arguments protected from shell splitting and injection?  
5. Can any supported launch path bind the API or web server to a public interface?  
6. Does the new shared helper behave correctly at runtime and match its type declaration?  
7. Did remediation preserve the previously correct process, database, and cloud-safety behavior?  
8. Is the implementation safe to accept?

## **Final instruction**

Be independent, skeptical, and evidence-driven.

The original review rejected the implementation for concrete behavioral defects. Your job is to establish whether those defects have actually disappeared—not whether the new code looks cleaner or has more tests.

A passing unit suite is not proof of live integration. A sandbox restriction is not an application defect, but it is also not a successful live test.

Do not modify anything. Do not self-certify based on the implementation report. Make the final acceptance decision based on the code and evidence you independently verify.

