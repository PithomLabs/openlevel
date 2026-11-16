Use this prompt with the coding agent. It is designed as a **read-only adversarial audit**, with special attention to the four fixes and the execution record you just reported. It treats the uploaded documentation as claims to verify against the implementation—not as proof that the implementation is correct.

# **Adversarial Code Review — OpenLevel Cross-Platform Taskfile and Local Development**

## **Role**

Act as an independent, skeptical senior engineer conducting a production-minded adversarial code review. Your job is to find defects, unsafe behavior, portability failures, misleading diagnostics, and gaps between documented guarantees and actual implementation.

Do not act as the implementation agent. Do not modify files. Do not make the review easier by accepting the author's explanations or test summaries at face value.

The objective is to determine whether the OpenLevel Taskfile and local-development tooling are genuinely reliable, safe, and portable across macOS and Linux—including older macOS systems—and whether the latest fixes have actually eliminated the problems they were intended to solve.

## **Review context**

Read these documents first:

* `docs/development/LOCAL_DEVELOPMENT.md`  
* `docs/development/TOOLCHAIN_COMPATIBILITY.md`

Locate the corresponding implementation, including at least:

* `Taskfile.yml`  
* `scripts/dev.mjs`  
* `scripts/toolchain.mjs`  
* `scripts/db-service.mjs`  
* Any additional scripts, helpers, tests, or configuration files referenced by the Taskfile.

Inspect the repository's actual current state. Do not assume filenames or paths are unchanged; locate the authoritative files.

The most recent execution report claims:

* Task listing, doctor, tool detection/planning, typechecks, Phase 0 unit tests, and build passed.  
* Database, Neon, and Fly safety guards refused invalid operations.  
* The main test suite reproduced a known baseline of 1 failure.  
* Integration, live development-server, and browser proofs were blocked by sandbox Docker/socket restrictions.  
* CLI variables were moved to Taskfile globals because Task 3.54 task-level defaults shadowed them.  
* The development launcher and doctor now distinguish `EPERM` from an occupied port.  
* IPv6 brackets are stripped before passing a PostgreSQL host to `psql -h`.  
* The compatibility documentation now records the executed verification and its limitations.  
* Bootstrap binaries were checksum-verified and run from `/tmp` because the sandbox denied writes to `~/.local/bin`; permanent installation remains an owner action.

These are **claims requiring independent verification**. Do not treat the report as evidence that the implementation is correct.

## **Non-negotiable review boundaries**

1. Read-only review. Do not edit, format, rewrite, generate, delete, or repair repository files.  
2. Do not commit, push, merge, deploy, or change branches.  
3. Do not install, upgrade, or remove host software.  
4. Do not authenticate to Fly, Neon, or any other external service.  
5. Do not create, modify, migrate, seed, reset, or delete remote databases or cloud resources.  
6. Do not start or stop system services or modify machine-level configuration.  
7. Never inspect, print, copy, or expose `.env` or other secret-bearing files. You may check whether a file exists without reading its contents.  
8. Do not invoke destructive commands simply to test whether a guard works.  
9. Do not claim a test passed unless you actually ran it and observed its result.  
10. If the environment prevents a test, report `NOT RUN` and explain the concrete blocker. Do not substitute a mock result and call it equivalent.

You may run safe, non-mutating inspection commands and existing tests that do not cross these boundaries. Preserve the existing working tree, including untracked files.

## **1\. Establish the review baseline**

Before examining implementation details:

* Record the current branch, commit, working-tree state, and untracked files.  
* Inspect the diff against the appropriate base revision.  
* Identify exactly which files changed in this iteration.  
* Confirm that no unrelated application code, dependencies, lockfiles, CI configuration, or deployment configuration changed unexpectedly.  
* Check that the implementation and documentation agree on actual paths, task names, environment variables, defaults, and runtime requirements.

Do not clean or reset the working tree.

## **2\. Taskfile variable resolution — critical regression check**

The reported change moved CLI variables to Taskfile globals because task-level defaults shadowed them under Task 3.54.

Independently establish whether the fix is correct.

Inspect every variable used by:

* `tools:detect`  
* `tools:plan`  
* `tools:install`  
* `tools:upgrade`  
* `tools:versions`  
* Doctor and platform checks  
* Fly and Neon commands  
* Database commands  
* Development-server commands

Check:

* Whether global variables are actually visible to the intended tasks.  
* Whether task-level `vars`, `env`, `dotenv`, command-line variables, and inherited environment variables interact as intended.  
* Whether a task-level declaration accidentally shadows a global default.  
* Whether defaults can override explicit user-supplied values.  
* Whether empty values, unset values, and invalid values are handled distinctly.  
* Whether nested task calls preserve the intended values.  
* Whether `task NAME VARIABLE=value` behaves consistently with the documented interface.  
* Whether the behavior is compatible with the declared minimum Task version, not merely the version used for the latest test.

Use Task's actual variable-resolution behavior and the installed version's documentation or executable to verify the implementation. Do not infer correctness from YAML appearance alone.

Test representative defaults and explicit overrides without triggering installation, authentication, or remote operations.

**Failure condition:** A documented command-line override is silently ignored, a global default shadows an explicit value, or a nested task receives a different value from the one the operator supplied.

## **3\. Development launcher — process and socket safety**

Review `scripts/dev.mjs` as though it will be used daily by developers on different Mac and Linux machines.

### **Port detection and error classification**

Specifically investigate the reported `EPERM` versus occupied-port fix.

Verify that:

* `EADDRINUSE` is reported as a port conflict.  
* `EPERM` is not automatically reported as proof that another process occupies the port.  
* `EACCES`, `EPERM`, `EADDRNOTAVAIL`, and other relevant failures are classified accurately.  
* The launcher does not falsely tell users to kill an unrelated process.  
* Port ownership diagnostics are best-effort and do not convert a failed diagnostic command into a successful readiness check.  
* An unavailable `lsof` or `ss` does not break otherwise valid operation.  
* The launcher never silently selects another port.  
* Explicit port overrides are validated and consistently propagated to the API, Vite proxy, health check, and printed URLs.

Pay particular attention to races between checking a port and binding it. A preflight check cannot guarantee that a port remains free.

### **Process lifecycle**

Verify:

* Both API and web processes are started with the correct working directory and environment.  
* Child output is forwarded without corrupting output or hiding errors.  
* Child exit, startup failure, readiness timeout, and partial startup all cause appropriate cleanup.  
* Ctrl+C, SIGTERM, and repeated signals are handled safely.  
* Process groups are terminated correctly on macOS and Linux.  
* Escalation to SIGKILL is bounded and does not kill unrelated processes.  
* No orphaned API, Vite, or watcher processes remain after shutdown.  
* A child that exits unexpectedly cannot leave the other child running indefinitely.  
* The parent reports a meaningful nonzero exit status when startup or a child process fails.

Check whether the implementation handles shell wrappers and grandchildren, not only the direct child PID.

### **Readiness and browser behavior**

Verify that:

* The API health endpoint is genuinely checked.  
* The frontend readiness check does not merely mistake an open TCP port for a working Vite application.  
* Timeouts are bounded and diagnostic.  
* `NO_BROWSER=1` is honored.  
* macOS uses the correct opener and Linux uses `xdg-open` when available.  
* Missing browser-opening tools produce a useful message without making a healthy server fail.  
* The browser opens only after the required readiness checks succeed.  
* Demo credentials and PGlite reset behavior match the actual application.

Confirm that both development servers bind to loopback only. Check IPv4/IPv6 behavior and ensure the Vite proxy targets the actual API host and port.

Do not claim live development works if sandbox socket restrictions prevent you from launching it.

## **4\. PostgreSQL guard and IPv6 handling**

The reported fix strips IPv6 brackets before passing the host to `psql -h`. Verify the entire connection-string path, not just the one-line change.

Test or reason through:

* `localhost`  
* `127.0.0.1`  
* `::1`  
* `[::1]` in a URL authority  
* IPv6 URLs with credentials and query parameters  
* Malformed URLs  
* Missing host or database name  
* Remote IPv4 and IPv6 addresses  
* DNS names other than explicitly allowed loopback names  
* Neon and Fly connection strings  
* Encoded credentials and unusual but valid URL characters

Confirm that:

* URL parsing uses a real URL parser rather than fragile string splitting.  
* IPv6 brackets are removed only where the downstream `psql -h` argument requires an unbracketed host.  
* The guard does not accidentally turn a remote host into an accepted loopback host.  
* The exact database name restriction is enforced.  
* Passwords and complete connection strings never appear in logs or error messages.  
* All mutating database tasks pass through the same guard.  
* A bypass is not available through a nested task, alternate environment variable, direct script invocation, or malformed URL.  
* PostgreSQL major-version mismatch handling cannot silently initialize, replace, or migrate an existing data directory.

Pay special attention to shell argument construction and injection risks. Verify that hostnames, database names, and credentials are passed as arguments safely rather than interpolated into shell commands.

Do not connect to or mutate a real database for this review. Use parsing tests or isolated, non-destructive tests only.

## **5\. Toolchain compatibility and installation**

Adversarially review `scripts/toolchain.mjs` and the documentation.

The policy is to select the newest stable version compatible with the detected host—not blindly install the newest globally available release.

Verify detection and resolution for:

* macOS version and architecture, including Intel and Apple Silicon.  
* Linux distribution, release, architecture, and codename.  
* Linux glibc versus musl where relevant.  
* Existing package managers and Node managers.  
* Existing tool installations and PATH resolution.  
* Supported versus unsupported host combinations.

Check the actual version-selection logic for:

* Node 22 as the mandatory OpenLevel runtime.  
* Optional latest Active LTS only where the host supports it.  
* The existing `.nvmrc` pin.  
* PostgreSQL selection based on vendor-supported OS and architecture.  
* Task, Fly CLI, and Neon CLI installation routes.  
* Official download origins and release-asset selection.  
* Checksum or signature verification wherever available.  
* Architecture mismatch and unsupported-binary handling.  
* Partial downloads, interrupted installs, and failed extraction.  
* PATH updates and fresh-shell behavior.  
* Existing installations that are newer but incompatible.  
* Clear `UNSUPPORTED`, `SKIPPED_OPTIONAL`, and `BLOCKED_OWNER_ACTION` outcomes.

Do not assume that a URL or installer route documented for one host is valid for every Mac or Linux distribution.

Check whether an install failure leaves a misleading success record, corrupt executable, partial installation, or changed PATH.

### **Installation safety**

Verify that:

* `tools:install` and `tools:upgrade` require their explicit confirmation gate.  
* Preview and planning tasks do not install anything.  
* Admin-required steps stop and provide exact owner instructions.  
* No tool installation authenticates to Fly or Neon.  
* No installation creates cloud resources.  
* No installation modifies application dependencies or regenerates the npm lockfile.  
* No Node major upgrade occurs automatically.  
* PostgreSQL binary installation never automatically upgrades, replaces, initializes, or migrates an existing data cluster.  
* The implementation does not force Homebrew or source builds on unsupported older macOS hosts.

The compatibility document's `/tmp` bootstrap record must not be mistaken for a persistent user installation. Verify that the implementation and documentation clearly distinguish session-scoped verification binaries from owner-managed workstation installations.

## **6\. Fly and Neon boundaries**

Inspect all Fly and Neon tasks and their underlying scripts.

Confirm that the read-only interface is genuinely read-only.

For Fly:

* App names must be explicit; no accidental inference from the working directory.  
* The isolated P2 staging configuration must never become the implicit product deployment target.  
* Read-only commands must not create or change resources.  
* `fly:deploy` must fail closed without all required explicit inputs.  
* It must reject the P2 staging configuration and P2 application.  
* It must require `CONFIRM_DEPLOY=yes`.  
* Missing product deployment configuration must produce a safe refusal, not an invented default.  
* A dry run must not accidentally perform a real deployment.

For Neon:

* Missing authentication must result in a clear `SKIPPED` state.  
* The task must never initiate login or request credentials.  
* Read-only tasks must not silently create, link, switch, or mutate projects or branches.  
* No environment-pull operation may expose remote secrets.

Review nested tasks and helper scripts for alternate paths around these protections.

## **7\. Task catalog and command correctness**

Inspect the entire Taskfile, not just the tasks mentioned in the report.

For every advertised command:

* Confirm that it exists.  
* Confirm that its description matches its behavior.  
* Confirm that its dependencies and variable propagation are correct.  
* Confirm that failure in a dependency stops later unsafe steps.  
* Confirm that the exit status is meaningful.  
* Confirm that a skipped optional tool does not block unrelated functionality.  
* Confirm that required tools are genuinely required.  
* Confirm that `task dev` does not require native PostgreSQL or Docker.  
* Confirm that `task check` runs the documented checks in the documented order.

Look for misleading task names, tasks that silently do nothing, accidental shell assumptions, incorrect working directories, and commands that work only because of the reviewer's current PATH.

Check the documented command catalog against `task --list`.

## **8\. Cross-platform adversarial review**

One Taskfile is intended to support macOS and Linux.

Do not treat a successful run on one macOS Intel sandbox as proof of Linux compatibility.

Search for:

* Bash-only syntax in scripts intended to run under `/bin/sh`.  
* GNU-only flags or tools used on macOS.  
* BSD/macOS-only behavior used on Linux.  
* Assumed availability of `lsof`, `ss`, `curl`, `tar`, `ps`, `open`, or `xdg-open`.  
* Hard-coded architecture names or binary download URLs.  
* Incorrect executable permissions.  
* Path separator, quoting, symlink, and temporary-directory assumptions.  
* Differences in process-group signaling and service management.  
* Linux systemd assumptions that fail on OpenRC or other init systems.  
* macOS Homebrew assumptions, especially on Monterey and Intel.  
* Shell environment differences between interactive and non-interactive sessions.

Where actual Linux execution is unavailable, use static inspection and portable helper tests. Label that evidence accurately. Do not claim runtime portability without a real Linux run.

## **9\. Verification and test evidence**

Independently reproduce every safe test that the environment allows.

At minimum, evaluate:

* Task listing and task schema validation.  
* Tool detection, planning, version reporting, and doctor.  
* Task variable defaults and command-line overrides.  
* Root typecheck.  
* Phase 0 typecheck.  
* Phase 0 unit tests.  
* Main unit suite.  
* Build.  
* Database URL guard tests.  
* IPv4 and IPv6 host handling.  
* Port error-classification tests.  
* Development launcher failure and cleanup tests that do not require prohibited sockets.  
* Fly and Neon refusal paths.  
* Confirmation-gate refusal paths.  
* Task dry runs where they cannot trigger mutations.

For the main test suite, distinguish the known one-failure baseline from newly introduced failures. Identify the exact failing test and verify whether the current failure is genuinely the same known issue; do not dismiss an unrelated failure as baseline.

For integration, live-server, browser, and PostgreSQL-backed tests:

* Run only when the environment supports them safely.  
* Otherwise report `NOT RUN`.  
* State the exact environmental limitation.  
* Do not convert a sandbox restriction into an application PASS.  
* Do not weaken or skip a test to obtain a green result.

Treat GitHub Actions as the authoritative confirmation for committed CI-only infrastructure tests, not as evidence that unrun local tests passed.

## **10\. Documentation accuracy**

Compare both uploaded documentation files with the actual implementation.

Verify:

* Every documented task exists and has the described semantics.  
* Ports, URLs, health endpoint, demo credentials, and reset behavior are accurate.  
* `.nvmrc`, `package.json` engines, and CI Node version agree.  
* PostgreSQL version policy and CI PostgreSQL version are clearly distinguished.  
* The local database guard description matches the actual accepted URL forms.  
* The Fly and Neon descriptions reflect real safeguards.  
* The owner-action sequence is safe and executable as written.  
* The `/tmp` bootstrap record clearly distinguishes temporary verification from persistent installation.  
* PASS, FAIL, and NOT RUN states are reported without ambiguity.  
* No sandbox-only result is presented as a general Mac/Linux guarantee.  
* No stale branch, commit, package version, or host fact is presented as current without qualification.

Do not silently repair inaccurate documentation. Report the discrepancy and its consequence.

## **11\. Adversarial scenarios**

Make a deliberate effort to reason through these failure scenarios:

1. A user supplies a custom port, but a nested task silently uses the default.  
2. Another process binds the port between preflight and server startup.  
3. The operating system denies `listen()` with `EPERM`; the message incorrectly claims the port is occupied.  
4. `lsof` or `ss` is missing when a port conflict occurs.  
5. The API starts but fails its health check while Vite remains alive.  
6. Vite starts but its API proxy points to the wrong port.  
7. The user presses Ctrl+C during partial startup.  
8. A child process exits while its sibling continues running.  
9. A child shell leaves grandchildren behind.  
10. `DATABASE_URL` contains `[::1]`, and the resulting `psql -h` argument is malformed.  
11. A crafted or malformed URL bypasses the loopback database guard.  
12. A Neon connection string is passed to a local database task.  
13. A newer PostgreSQL binary is installed while an older data directory exists.  
14. A Linux host uses musl rather than glibc.  
15. A Monterey Intel Mac has no Homebrew and cannot use the newest globally available package.  
16. A tool download is interrupted or fails checksum verification.  
17. An existing incompatible binary is found earlier on PATH than the newly installed binary.  
18. Fly or Neon authentication is missing.  
19. A user attempts to deploy using the isolated P2 configuration.  
20. A documented optional tool is absent and unexpectedly blocks `task dev`.

For each relevant scenario, determine whether the implementation safely handles it, fails closed with an accurate explanation, or has a defect.

## **12\. Required review output**

Start with one verdict:

* **APPROVE** — no blocking or material non-blocking findings.  
* **APPROVE WITH FINDINGS** — no release-blocking defect, but specific issues should be addressed.  
* **REJECT** — one or more correctness, safety, or reliability defects make the implementation unsuitable for acceptance.

Then provide:

### **A. Executive verdict**

State the verdict and the most important reason. Be direct. Do not praise effort or repeat the implementation report.

### **B. Findings**

Order findings by severity:

* **P0 — Critical:** destructive operation, secret exposure, remote mutation without authorization, or severe security boundary failure.  
* **P1 — High:** core development workflow broken, guard bypass, process leak, or material cross-platform failure.  
* **P2 — Medium:** incorrect behavior, misleading diagnostics, or significant compatibility/documentation mismatch.  
* **P3 — Low:** minor reliability, usability, or maintenance issue.

For every finding include:

* Exact file and line or function.  
* Concrete defect and impact.  
* Reproduction steps or a clear failure scenario.  
* Why existing tests did not catch it.  
* Smallest appropriate correction.  
* Whether it is a regression introduced in this iteration or a pre-existing issue.

Do not manufacture findings. If an area is correct, say so briefly and identify the evidence.

### **C. Required-fix list**

Separate genuine blockers from non-blocking recommendations. Do not mix preferences with defects.

### **D. Verification record**

List every command actually executed and classify its result:

* `PASS`  
* `FAIL`  
* `NOT RUN`  
* `BLOCKED`

Include relevant exit codes and concise explanations. Distinguish tests reproduced in this review from results merely reported in the compatibility document.

### **E. Portability confidence**

State what is demonstrated on the actual review host and what remains unverified for other platforms. In particular, do not equate static Linux inspection with a Linux runtime test.

### **F. Final acceptance decision**

Answer these questions explicitly:

1. Is the Task 3.54 global-variable correction actually correct?  
2. Is the `EPERM` versus occupied-port distinction correct?  
3. Is IPv6 handling correct from URL parsing through `psql -h`?  
4. Are the database, Fly, and Neon safety boundaries effective?  
5. Can `task dev` reliably start and stop both processes on supported hosts?  
6. Is the toolchain resolver genuinely host-compatible rather than merely host-aware?  
7. Are the uploaded documents accurate representations of the implementation?  
8. Is the current implementation safe to accept?

## **Final instruction**

Be skeptical, specific, and evidence-driven. Do not implement fixes. Do not inflate the review with speculative style comments. Do not approve merely because the reported checks are green.

The objective is to discover what could still fail on a real developer workstation, especially in the uncomfortable edge cases that normal happy-path tests rarely exercise.

When evidence is unavailable, state that limitation plainly. An honest `NOT RUN` is better than a false PASS.

The review should finish with a clear acceptance decision—not a patch. Any required corrections can then be handled in a separate, narrowly scoped implementation pass.

