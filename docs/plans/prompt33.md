# **OpenLevel — Final Release Preparation and GitHub Publication**

## **Objective**

Prepare the completed cross-platform Taskfile and local-development implementation for publication to the canonical GitHub repository:

`PithomLabs/openlevel`

The owner has manually tested `task dev` on the actual workstation and confirmed that it works. Treat this as an owner-reported live smoke test, distinct from tests independently executed by the coding agent.

The implementation has passed the independent Adversarial Re-Review 10 for all five original findings. The review also identified:

* P2-N1: IPv6 launcher URL construction can fail and potentially leave detached child processes running.  
* P3-N1: New scripts and Vite configuration are not fully covered by the existing TypeScript gates.

The objective is to prepare a complete, safe, reviewable commit without including unrelated work.

## **1\. Preserve the repository state**

Before doing anything:

1. Record the current branch and commit.  
2. Inspect `git status --short`.  
3. Inspect tracked modifications, untracked files, and deleted files.  
4. Inspect `git diff` and `git diff --stat`.  
5. Identify all files required for the complete local-development implementation.  
6. Confirm the working tree has not changed unexpectedly since Adversarial Re-Review 10\.

Do not:

* Checkout another branch.  
* Reset, clean, rebase, or force-update anything.  
* Discard or overwrite untracked work.  
* Stage everything with `git add .` or `git add -A`.  
* Include unrelated planning documents or review reports.

Preserve the existing `CLAUDE.md` deletion exactly as it stands. It was explicitly deferred for owner disposition and must not be included in this release.

Never inspect or print `.env` or other secrets.

## **2\. Resolve P2-N1 before publication**

Inspect the current implementation of:

* `scripts/dev.mjs`  
* `scripts/lib/dev-env.mjs`  
* `scripts/lib/dev-env.test.ts`  
* `scripts/dev-rejection.test.ts`

Determine whether P2-N1 from Adversarial Re-Review 10 has already been fixed.

The issue is that an IPv6 host of `::1` can generate malformed URLs such as:

`http://::1:8790`

The correct representation is:

`http://[::1]:8790`

If the defect remains, implement the smallest safe correction before preparing the commit:

* Use proper URL construction and IPv6 bracket handling.  
* Apply the same logic to health probes and browser-opening URLs.  
* Ensure exceptions during startup, readiness checks, and browser opening always trigger child-process cleanup.  
* Prefer guaranteed cleanup through `try/finally` or an equivalent reliable lifecycle mechanism.  
* Preserve existing IPv4 behavior and port overrides.  
* Add regression tests for `health`, `open`, and `run` modes.  
* Verify that invalid URLs or failed readiness checks cannot leave detached children behind.

Do not remove IPv6 support merely to make a test pass unless the safer alternative is to explicitly reject it and update the documentation consistently.

If P2-N1 is already fixed, verify the fix rather than rewriting it.

## **3\. Handle P3-N1 without scope expansion**

Check whether a dedicated typecheck for the new scripts and `vite.config.ts` has been added.

Do not redesign the existing TypeScript configuration.

A small dedicated typecheck is acceptable if it can be introduced without changing application behavior or disturbing the existing CI gates.

Otherwise, retain P3-N1 as a documented follow-up. Do not silently claim it is resolved.

The following previously deferred items must remain out of scope:

* P3-1: `task check` and the pinned vault baseline failure.  
* P3-2: Doctor's hardcoded port checks.  
* P3-3: Minimum Task version declaration.  
* P3-4: Direct npm migration/seed guard hardening.

## **4\. Final verification**

Follow the repository's local-first verification policy.

Run the available checks in this order:

1. Taskfile parsing and `task --list`.  
2. Focused development configuration and launcher tests.  
3. Taskfile contract tests.  
4. IPv4 and IPv6 URL and cleanup regression tests.  
5. Fly/Neon argument-safety tests.  
6. Root typecheck.  
7. Phase 0 typecheck.  
8. Phase 0 unit suite.  
9. Main unit suite.  
10. Production build.

Verify the known main-suite vault baseline failure against its exact test name and baseline record. Do not conceal new failures by describing them as baseline.

### **Live development**

The owner reports that `task dev` works on the actual workstation.

Record this as:

`OWNER-REPORTED PASS — live task dev smoke test.`

Do not misrepresent the owner's test as an agent-executed test.

Where practical, verify:

* API and web startup.  
* API health endpoint.  
* Browser opening.  
* Ctrl+C shutdown.  
* No remaining child processes.  
* Default IPv4 ports.  
* A non-default API port.  
* A real Vite `/api` request.

If the agent can reproduce these checks locally, record its own command and results separately.

Do not install Docker or change workstation software.

## **5\. Establish the exact commit contents**

Identify the complete set of files that constitute this feature.

Include all necessary implementation and supporting files, including the Taskfile, launcher, shared helpers, database-service helper, toolchain logic, configuration, project documentation, and tests.

Do not assume that the eleven files from the last review constitute the entire feature. Inspect dependencies and include the foundational Prompt29 work required to make the workflow functional on a clean checkout.

Potential files include:

* `Taskfile.yml`  
* `.nvmrc`  
* `AGENTS.md`  
* `scripts/dev.mjs`  
* `scripts/toolchain.mjs`  
* `scripts/db-service.mjs`  
* `scripts/lib/dev-env.mjs`  
* `scripts/lib/dev-env.d.mts`  
* `scripts/lib/dev-env.test.ts`  
* `scripts/taskfile-contracts.test.ts`  
* `scripts/dev-rejection.test.ts`  
* Relevant development configuration files.  
* `docs/development/LOCAL_DEVELOPMENT.md`  
* `docs/development/TOOLCHAIN_COMPATIBILITY.md`  
* Other necessary supporting tests or files.

This is a candidate list, not an instruction to stage every path blindly.

Explicitly exclude:

* `.env` and all secret-bearing files.  
* `CLAUDE.md` deletion.  
* `docs/plans/` working documents unless specifically required by the application.  
* `adv_review*.md`.  
* `prompt*.md`.  
* Temporary test output and generated artifacts.  
* Unrelated changes or personal notes.

## **6\. Inspect Git remotes and publication target**

The canonical remote is expected to be:

`fork` → `https://github.com/PithomLabs/openlevel`

The personal fork is expected to be:

`origin` → `https://github.com/jahfeelautomation/openlevel`

Verify the actual remote configuration. Do not expose embedded credentials if any remote contains them.

Use `fork` as the publication target. Do not accidentally push to `origin`.

The canonical repository's default branch is `master`, not `main`.

Fetch remote references if safe and inspect:

* Current local branch.  
* Current commit.  
* Canonical `fork/master` commit.  
* Whether the working branch is based on the expected history.  
* Whether a remote branch with the current name already exists.  
* Whether the proposed push would be a fast-forward.

Do not push directly to `master`.

If the current branch is stale, divergent, or conflicts with the remote branch, stop and report the situation. Do not automatically rebase, reset, force-push, or merge.

Never force-push.

## **7\. Prepare the commit**

The intended commit message is:

`feat(dev): add cross-platform local development workflow`

Before publication, prepare an explicit file allowlist.

Review the staged diff independently:

* `git diff --cached --stat`  
* `git diff --cached --check`  
* `git diff --cached`

Confirm:

* No secrets are staged.  
* No unrelated deletion is staged.  
* No planning documents are staged.  
* No CI, dependency, or lockfile changes have appeared unexpectedly.  
* No production deployment configuration has been introduced.  
* All implementation dependencies are present.  
* Documentation matches the final implementation.  
* The P2-N1 disposition is explicit.

Do not use a wildcard staging command.

## **8\. Git execution boundary**

The repository owner performs the final Git mutations manually.

Do not execute:

* `git add`  
* `git commit`  
* `git push`  
* `git merge`  
* `git rebase`  
* `git reset`  
* `git clean`

Instead, provide the exact Git commands in separate lines, in the correct execution order, for owner review and execution.

Provide:

1. Explicit individual `git add` commands for the reviewed allowlist.  
2. The staged-diff verification commands.  
3. The proposed commit command.  
4. The push command targeting `fork` and the verified feature branch.  
5. Remote verification commands to confirm the published branch and commit SHA.

Do not invent the branch name. Use the actual verified current branch name.

If publication cannot safely proceed because of branch ancestry, remote divergence, or unrelated working-tree changes, explain the blocker and provide the safest next commands rather than attempting to repair history automatically.

## **9\. Final report**

Return:

### **A. Release-readiness verdict**

Choose:

* `READY TO COMMIT`  
* `NOT READY`

### **B. Verification results**

Record each check as PASS, FAIL, NOT RUN, or BLOCKED.

Distinguish agent-executed results from the owner's live `task dev` test.

### **C. P2-N1 and P3-N1 disposition**

Explicitly state whether each is fixed, deferred, or unresolved.

### **D. Exact commit contents**

List every file proposed for inclusion and every known exclusion.

### **E. Git publication status**

Report:

* Current branch.  
* Current commit SHA.  
* Canonical remote URL.  
* Canonical master SHA.  
* Proposed feature branch.  
* Whether the branch is safe to push without rewriting history.

### **F. Owner-executable Git commands**

Provide the exact commands, one per line, without executing them.

### **G. Post-push verification**

Provide commands to verify that the canonical remote contains the expected branch and commit SHA.

## **Final instruction**

This is the final release-preparation pass for the OpenLevel local-development tooling.

Keep the commit focused, preserve every unrelated owner change, and do not rewrite Git history.

A clean, reproducible commit with a verified file allowlist is more important than publishing quickly.

