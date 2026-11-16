# **Adversarial review:** `plan_prompt24.1.md`

Approved with one minor refinement

This revision correctly incorporates both mandatory amendments from the previous review. I would approve it for implementation.

## **What is now correct**

**Fix A — schema mismatch**

The extraction of `PUBLIC_TRUNCATE_TABLES` into an importable module is the right approach. It solves the weakness in the previous proposal: the regression test now checks the actual allowlist values rather than searching for a string that never existed in the defective implementation.

The exact-set assertion is particularly useful because it prevents future accidental additions of staging-only tables to the local `public` privilege list.

Including `app` in the prototype inventory also makes the setup report consistent with the actual schema layout.

**Fix B — role creation**

The correction explicitly uses:

```
await ownSys.query(createRoleStatement(appRole));
```

before `DBOS.migrate()`.

This is the right connection boundary. The plan also correctly recognizes that the existing CI test uses identical privileged credentials for both connections, so its success cannot establish that the system/application privilege separation is correct.

**Fix C — Bash exit code**

The plan preserves the application's fail-closed behavior and fixes the test rather than weakening the application.

**Validation and boundaries**

I agree with the existing live double-application proof, the decision not to repeat it unnecessarily, and the prohibition on local Docker installation, cloud access, commits, and pushes.

plan_prompt24.1.md

## **One minor refinement**

For Fix C, initialize the status variable explicitly:

```
status=0
docker run --rm -e ROLE=bogus p2staging:ci node phase0/p2/probe-web.mjs || status=$?
test "$status" -eq 2
```

This is slightly more robust than relying on `${status:-0}`. It ensures the expected exit-code assertion uses a known initial value.

The three possible outcomes remain correct:

| Actual exit code | Assertion |
| ---------------- | --------- |
| 0                | Fails     |
| 1                | Fails     |
| 2                | Passes    |

## **Implementation acceptance criteria**

I would require these specific pieces of evidence in the coding agent's final report:

1. The Fix A regression test fails when `p2_probe_log` is temporarily restored to the public TRUNCATE allowlist.
2. The Fix B regression test fails with the original ordering and wrong connection target.
3. The Fix C test proves the expected exit code is exactly two.
4. Unit tests, root typecheck, and Phase 0 typecheck pass.
5. The agent reports Docker-backed tests as **not run locally**, rather than claiming success based on static checks.
6. No unrelated architecture or application changes.

**My recommendation: proceed with this plan.** It is sufficiently narrow, has meaningful regression coverage, and addresses the actual causes of all three failures.

The next release gate remains the next GitHub Actions run after you publish the changes. Until that run passes, P2 staging acceptance remains incomplete.
