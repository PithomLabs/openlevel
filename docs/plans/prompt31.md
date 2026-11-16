The implementation prompt below keeps the work tightly scoped to the five rejection findings. It explicitly defers the P3 recommendations so the coding agent does not turn a small corrective pass into another tooling redesign.

# **Implementation Prompt — OpenLevel Adversarial Review 9 Remediation**

## **Objective**

Implement the five required fixes identified in `adv_review9.md`, then perform a focused local verification pass.

The review verdict was **REJECT** because one documented development-server feature is broken and four additional defects affect diagnostics, networking, command safety, and the loopback security boundary.

This is a corrective implementation task, not an opportunity to redesign the Taskfile or expand the development toolchain.

**Required scope: P1-1 and P2-1 through P2-4 only.**

Read these files before changing anything:

* `adv_review9.md`  
* `docs/development/LOCAL_DEVELOPMENT.md`  
* `docs/development/TOOLCHAIN_COMPATIBILITY.md`

Inspect the current implementation of `Taskfile.yml`, `scripts/dev.mjs`, `scripts/toolchain.mjs`, `server/dev-server.ts`, and `vite.config.ts`. Locate any relevant tests and supporting scripts.

The review's line numbers are from the reviewed snapshot. Reconfirm the current implementation before editing.

## **Non-negotiable operating rules**

1. Preserve the current branch and working tree. Do not checkout, reset, clean, rebase, or discard existing changes.  
2. Do not commit, push, merge, or deploy.  
3. Do not install or upgrade workstation software.  
4. Do not authenticate to Fly or Neon or perform any remote operation.  
5. Do not start, stop, migrate, seed, or modify a real database or cloud resource.  
6. Never inspect, print, or expose `.env` or other secret-bearing files.  
7. Do not modify CI configuration, application dependencies, package versions, or the lockfile.  
8. Preserve the existing Task 3.54 global-variable correction. Do not reintroduce task-level defaults that shadow global CLI variables.  
9. Do not modify production server behavior to fix local-development problems.  
10. Do not claim tests passed unless they were actually executed.

Use the smallest changes that correct the defects. Add focused regression tests where appropriate.

## **1\. P1-1 — Make API port overrides work end to end**

**Finding:** `task dev API_PORT=8899` is accepted by the launcher, but `server/dev-server.ts` still binds to hardcoded port `8790`, and `vite.config.ts` still proxies to hardcoded port `8790`.

The launcher then waits for health on `8899` until timeout, even though the API started on `8790`.

The documentation promises port overrides. That promise must become true.

### **Required implementation**

Make the API port a single, consistently resolved runtime configuration value.

The value must propagate through:

* Taskfile `dev`  
* `dev:api`  
* `dev:web`  
* `dev:health`  
* `dev:open`  
* `scripts/dev.mjs`  
* `server/dev-server.ts`  
* `vite.config.ts`

Preserve existing defaults:

* API: `8790`  
* Web: `5273`  
* Host: `127.0.0.1`

Use the existing Taskfile global-variable mechanism and ensure explicit CLI overrides take precedence over defaults.

The development launcher must validate and normalize the chosen values before spawning children. Pass the resulting configuration to both child processes through an explicit environment contract.

`server/dev-server.ts` must read the effective API port and bind to the effective validated loopback host rather than hardcoding the port.

`vite.config.ts` must use the same effective API port and host for its `/api` proxy target.

Do not solve this by changing only the launcher's health check. The actual API listener, Vite proxy, health check, and printed URLs must all agree.

### **Regression requirements**

Verify at least:

* Default `task dev`: API `8790`, web `5273`.  
* `task dev API_PORT=8899`: API listens on `8899`; health checks `8899`; Vite proxies to `8899`.  
* `task dev WEB_PORT=5280`: Vite listens on `5280`; API remains on `8790`.  
* Both overrides together.  
* Standalone `dev:api`, `dev:web`, `dev:health`, and `dev:open` honor the same configuration contract.  
* Invalid ports are rejected before child processes start.  
* No configuration is silently ignored.

Prefer a focused shared configuration helper if that avoids inconsistent validation across the launcher, API, and Vite. Do not introduce unnecessary abstraction.

## **2\. P2-1 — Correctly classify all bind failures**

**Finding:** `scripts/dev.mjs` and `scripts/toolchain.mjs` distinguish `EPERM` and `EACCES` from occupied ports, but other errors such as `EADDRNOTAVAIL` and unknown errors still fall through to the misleading "already in use" diagnosis.

### **Required implementation**

Distinguish these conditions explicitly:

* `EADDRINUSE`: another process is occupying the requested address/port.  
* `EPERM` and `EACCES`: the operating system denied the bind or probe.  
* `EADDRNOTAVAIL`: the requested address is not available on this host.  
* Other errors: report a generic bind/probe failure with the actual error code and useful diagnostic context.

Never tell users to kill another process unless the actual error is `EADDRINUSE`.

Apply consistent classification to the development launcher and doctor/toolchain diagnostics.

Keep owner/process discovery best-effort. Missing `lsof` or `ss` must not convert a failed probe into success or produce an inaccurate diagnosis.

### **Regression tests**

Add or extend tests covering each error category, especially:

* `EADDRINUSE`  
* `EPERM`  
* `EACCES`  
* `EADDRNOTAVAIL`  
* An unknown error code

Verify that only `EADDRINUSE` produces the occupied-port message.

## **3\. P2-2 — Make the Vite proxy target match the API listener**

**Finding:** The API now binds to `127.0.0.1`, while the Vite proxy uses `localhost`. On the reviewed host, Node resolves `localhost` to `::1` first. The current behavior relies on address-family fallback and creates unnecessary fragility.

### **Required implementation**

Make the Vite proxy use the same canonical effective address as the API listener.

The default path must use:

`http://127.0.0.1:<effective-api-port>`

Do not rely on DNS ordering, implicit IPv4/IPv6 fallback, or an unrelated service potentially listening on the alternate address.

When implementing configurable loopback addresses, ensure the proxy target is constructed from the normalized, validated address and port. Use proper URL handling for IPv6 rather than manual string concatenation.

### **Regression tests**

Verify:

* Default proxy target is exactly the IPv4 loopback API endpoint.  
* API port override changes the proxy target.  
* The proxy target matches the address on which the API actually binds.  
* IPv6 handling, if supported, produces a valid URL with correct bracket syntax.  
* No accidental proxy target uses a wildcard or external interface.

## **4\. P2-3 — Eliminate unsafe shell interpolation in Fly tasks**

**Finding:** Fly task commands interpolate `FLY_APP` and `FLY_CONFIG` into shell command strings. Unquoted expansion and embedded quotes can split arguments or alter command interpretation.

### **Required implementation**

Inspect every Fly task that accepts an app name or configuration path, including read-only commands and the guarded deploy task.

Do not interpolate user-supplied values directly into shell source.

Use Taskfile environment variables and properly quoted shell expansion, or another argument-passing method that preserves values as individual arguments.

For example, the intended pattern is:

```
env:
  FLY_APP: '{{.FLY_APP}}'
cmds:
  - fly status -a "$FLY_APP"
```

Apply the same principle to `FLY_CONFIG` and every other externally supplied Fly argument.

Preserve all existing security requirements:

* Explicit app name; no implicit inference.  
* P2 staging configuration rejection.  
* P2 application rejection.  
* Required `CONFIRM_DEPLOY=yes`.  
* Missing or invalid configuration must fail closed.  
* No authentication or deployment during this remediation.

Do not weaken the existing deployment guard while changing argument handling.

### **Regression tests**

Test values containing:

* Ordinary valid app names.  
* Paths containing spaces.  
* Quotes.  
* Shell metacharacters.  
* Empty and unset values.

Verify that each value is passed as one argument and cannot inject another shell command.

Use a harmless local test harness or argument-capturing stub. Never invoke a real Fly deployment.

## **5\. P2-4 — Enforce the loopback-only development boundary**

**Finding:** The `LOOPBACK` override is not validated. A value such as `0.0.0.0` can cause Vite to bind on all interfaces, contradicting the documented loopback-only guarantee.

### **Required implementation**

Validate the effective host before either development process is spawned.

The default must remain `127.0.0.1`.

Only permit explicitly supported loopback addresses. A reasonable allowlist is:

* `127.0.0.1`  
* `::1`  
* `localhost`, provided it is normalized consistently and does not cause API/proxy address divergence.

Reject:

* `0.0.0.0`  
* `::`  
* Non-loopback IPv4 or IPv6 addresses.  
* Arbitrary DNS names.  
* Malformed or ambiguous host values.

The API and Vite must use the same effective loopback configuration.

If supporting a configurable host creates unnecessary complexity, it is acceptable to retain the fixed `127.0.0.1` behavior and reject non-default host overrides explicitly. Do not silently ignore a supplied host.

The security guarantee must hold in both the launcher and the individual development-server tasks. A caller must not bypass the check by invoking `dev:api` or `dev:web` directly.

### **Regression tests**

Verify that:

* Default host is `127.0.0.1`.  
* Supported loopback overrides work consistently, if retained.  
* `LOOPBACK=0.0.0.0` is rejected before either child starts.  
* `LOOPBACK=::` is rejected.  
* External IP and arbitrary hostname values are rejected.  
* Error messages clearly explain that only loopback binding is permitted.

## **6\. Preserve the existing correct behavior**

The adversarial review independently verified several areas as correct. Do not regress them.

In particular, preserve:

* Task 3.54 global-variable resolution and CLI override precedence.  
* Existing Taskfile task catalog.  
* EPERM/EACCES distinction already implemented.  
* Process-group cleanup, sibling shutdown, and bounded SIGTERM/SIGKILL escalation.  
* Real HTTP readiness checks.  
* `NO_BROWSER=1`.  
* IPv6 bracket stripping before `psql -h`.  
* PostgreSQL URL parsing and local-only database restrictions.  
* Fail-closed Fly and Neon guards.  
* PostgreSQL major-version upgrade protection.  
* Node 22 project runtime, `.nvmrc`, package engines, and CI pins.  
* PGlite-based `task dev`, which must remain independent of native PostgreSQL and Docker.

Do not make broad refactors to already-correct subsystems.

## **7\. Explicitly deferred findings**

The following findings were classified as P3 or administrative follow-up. Do not expand this remediation into those issues unless a required fix directly depends on them.

* **P3-1:** `task check` encounters the known pinned vault test failure before reaching later checks. Do not weaken the test or change its baseline in this pass.  
* **P3-2:** Doctor hardcodes default ports. Do not independently redesign doctor; only update it where required to keep the P2-1 bind-error classification correct.  
* **P3-3:** Declare a minimum Task version. Defer this decision.  
* **P3-4:** Direct `npm run migrate` and `npm run seed` can bypass the Taskfile database guard. Do not introduce a broader database architecture or migration redesign.  
* **Unrelated `CLAUDE.md` deletion:** Do not restore, delete, or otherwise alter it as part of this task. Preserve its current state and report it separately for owner disposition.

Record these as deferred rather than quietly treating them as fixed.

## **8\. Verification strategy**

Follow the project's Local-First, CI-Confirmed, Owner-Authorized Operations discipline.

Run focused tests first, followed by the locally available checks:

1. Taskfile parse and task listing.  
2. Global-variable and CLI override tests.  
3. Launcher configuration and validation tests.  
4. Bind-error classification tests.  
5. Vite proxy target tests.  
6. Fly argument-safety tests using harmless stubs.  
7. Loopback rejection tests.  
8. Root typecheck.  
9. Phase 0 typecheck.  
10. Phase 0 unit tests.  
11. Main unit suite.  
12. Build.

Run a live `task dev` proof if the environment permits local sockets. Verify both the default configuration and at least one non-default API port, including an actual request through the Vite `/api` proxy.

If sockets are blocked by the execution sandbox, report the live test as `NOT RUN` and state the exact blocker. Do not claim a live proof based solely on static inspection or mocked tests.

Do not install Docker or ask the owner to install it. Docker/Testcontainers tests may remain `NOT RUN` locally and CI-confirmed.

Do not run Fly, Neon, or remote database operations.

### **Required execution evidence**

For every check, record:

* Exact command.  
* Exit status.  
* `PASS`, `FAIL`, `NOT RUN`, or `BLOCKED`.  
* Concise result or environmental reason.

For the main test suite, distinguish the existing pinned vault failure from new failures. Do not silently classify a different failure as baseline.

## **9\. Documentation updates**

Only change documentation where required to make it match the corrected behavior.

At minimum, verify that `LOCAL_DEVELOPMENT.md` accurately describes:

* API and web port overrides.  
* Supported loopback configuration.  
* The actual API/Vite proxy behavior.  
* Port conflict versus permission/address errors.

Do not add broad documentation sections or rewrite unrelated material.

## **10\. Final report**

When finished, provide:

### **A. Implementation summary**

List each modified file and the exact correction made.

### **B. Finding disposition**

For each finding, state:

* P1-1: FIXED / NOT FIXED  
* P2-1: FIXED / NOT FIXED  
* P2-2: FIXED / NOT FIXED  
* P2-3: FIXED / NOT FIXED  
* P2-4: FIXED / NOT FIXED

Include evidence, not just assertions.

### **C. Verification results**

Show the exact tests run and their PASS/FAIL/NOT RUN/BLOCKED states.

### **D. Deferred issues**

List P3-1 through P3-4 and the unrelated `CLAUDE.md` deletion as deferred or owner-disposition items. Do not claim they were fixed.

### **E. Remaining risks**

State what still requires a real workstation, browser, Docker, PostgreSQL, or Linux environment.

### **F. Recommendation**

Choose one:

* **READY FOR RE-REVIEW** — all five required findings fixed and locally verifiable to the extent the environment permits.  
* **NOT READY** — any required finding remains unresolved or a regression was introduced.

Do not self-approve the implementation. The next step is an independent adversarial re-review using the original review criteria.

## **Final instruction**

Make only the five required corrections. Preserve the user's existing work and all established safety boundaries. No commits, pushes, deployments, cloud mutations, or unrelated cleanup.

A small, demonstrably correct fix is preferable to a large refactor that introduces new risks.

**Important:** the agent should return **READY FOR RE-REVIEW**, not APPROVE. The independent review should decide whether the fixes actually close the rejection findings.

