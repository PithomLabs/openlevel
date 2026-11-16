# **Adversarial review: `plan_prompt24.md`**

Approve with revisions

Two required corrections

The plan correctly identifies all three CI failures and keeps the remediation appropriately narrow. I agree with the overall approach: fix the schema mismatch, correct role-creation order, and repair the Bash assertion without weakening application behavior.

However, **two details need to be corrected before giving this plan to the coding agent.** One would allow a regression test to pass without detecting the original bug; the other could preserve a privilege-boundary problem.

## **1\. Fix A: the proposed regression test does not catch the original bug**

The plan proposes asserting that `setup-db.ts` contains no `"public"."p2_` reference.

That assertion is inadequate. The original code constructs the SQL dynamically:

```
const prototypeTables = [
  // ...
  'p2_probe_log',
  // ...
];

await admin.query(
  `GRANT TRUNCATE ON ${prototypeTables.map((t) => `"public"."${t}"`).join(', ')} TO "${RUNTIME_ROLE}"`
);
```

There is no literal `"public"."p2_` in the source. The original defective implementation would therefore pass that proposed assertion.

The other two proposed assertions are also insufficient individually:

* `stagingGrants()` already uses the `app` schema.  
* `phase0/p2/schema.sql` already defines the P2 proof tables under `app`.

Neither detects the incorrect entry in the local setup's `prototypeTables` list.

**Required correction:** test the actual contents of the public-schema TRUNCATE allowlist. Either extract the list into a small testable constant or parse the existing array from the source. Assert specifically that `p2_probe_log` is absent. Also assert that the inventory query includes `app`.

This test must demonstrably fail against the original code.

## **2\. Fix B: create the role through the system connection**

The plan says to move `createRoleStatement(appRole)` before `DBOS.migrate()`, but it does not specify which pool executes the statement.

That omission matters.

The existing implementation uses separate connections:

* `ownSys` for DBOS system database operations.  
* `ownApp` for application schema operations.

Creating PostgreSQL roles is a system-level operation. The system connection is the appropriate connection to perform that operation, especially when the application connection is deliberately subject to tighter privileges.

The corrected sequence should be:

```
// Role must exist before DBOS attempts its privilege grants.
if (appRole) {
  await ownSys.query(createRoleStatement(appRole));
}

await DBOS.migrate(
  sysUrl,
  appRole
    ? { schemaName: 'dbos', applicationRole: appRole }
    : { schemaName: 'dbos' }
);

// Continue with application schema and grants.
```

The exact placement of the other existing operations should preserve their intended connection responsibilities.

The regression test should assert both:

1. Role creation occurs before `DBOS.migrate()`.  
2. Role creation uses `ownSys`, not `ownApp`.

There is another reason to be careful: the current CI test supplies the same PostgreSQL superuser URL for both connections. It can pass even if role creation incorrectly depends on the application connection having elevated privileges.

Do not treat the current identical CI credentials as proof that the system/application privilege boundary is correct.

## **3\. Fix C: approve**

The proposed Bash correction is sound:

```
docker run --rm -e ROLE=bogus p2staging:ci node phase0/p2/probe-web.mjs || status=$?
test "${status:-0}" -eq 2
```

Under `bash -e`, the failing command is part of an `||` list, so its expected nonzero status can be captured. The subsequent assertion still rejects both an unexpected zero and any exit code other than two.

Keep `probe-web.mjs` unchanged. Its refusal behavior is correct.

The static workflow regression test should check that the negative test uses the safe status capture and exact exit-code assertion.

## **4\. Other parts of the plan**

I approve these decisions:

* Removing `p2_probe_log` from the `public` TRUNCATE allowlist rather than moving its table into `public`.  
* Including the `app` schema in the prototype inventory.  
* Leaving ownership tracking and teardown behavior intact, subject to verifying the existing schema-qualified ownership tests.  
* Reusing the existing live staging-apply test for double application and sentinel preservation.  
* Keeping `NOLOGIN`, separate database pools, and least-privilege grants.  
* Leaving P1, P3, backpressure, and the vault baseline untouched.  
* Running Docker-backed validation through GitHub Actions rather than asking you to install Docker locally.  
* No commits, pushes, merges, cloud access, or staging operations.

The plan's scope and validation boundaries are appropriate.

plan\_prompt24.md

## **Required amendments before implementation**

Give the coding agent these two additions:

### **Mandatory amendments to prompt24**

**Amendment A — make the Fix A regression test genuinely discriminating**

The proposed assertion that `setup-db.ts` contains no literal `"public"."p2_` is invalid because the original defect uses a dynamically constructed SQL statement.

Test the actual `prototypeTables` public-schema TRUNCATE allowlist. Assert that `p2_probe_log` is absent from that list. Also assert that the prototype inventory query includes the `app` schema.

Demonstrate that the regression test fails against the original implementation, not merely that it passes after editing.

**Amendment B — use the system connection for role creation**

In `applyStagingSetup()`, execute `createRoleStatement(appRole)` through `ownSys`, before `DBOS.migrate()`.

Do not execute PostgreSQL role creation through `ownApp` merely by moving the existing line upward. Preserve the separation between system-level operations and application-schema operations.

Extend the regression test to verify both the ordering and the connection target: `ownSys.query(createRoleStatement(appRole))` must occur before `DBOS.migrate()`.

The existing live CI test uses identical privileged credentials for both URLs. Do not interpret its success alone as proof of the connection privilege boundary.

All other scope restrictions, validation requirements, and Git/cloud boundaries in prompt24 remain unchanged.

**Final verdict:** The plan is sound once these two amendments are incorporated. I would not expand the work beyond these three CI failures. The next meaningful milestone is a complete green Actions run, not another round of infrastructure changes.

