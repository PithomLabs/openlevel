# **Targeted Remediation — P2 SQL Comment/Semicolon Splitter**

## **Context**

GitHub Actions run:  
[https\://github.com/PithomLabs/openlevel/actions/runs/43745802184](https://github.com/PithomLabs/openlevel/actions/runs/43745802184)

Five jobs passed:

* unit  
* typecheck  
* app-suite  
* integration  
* p2-packaging

Only `p2-boot-proof` failed.

T1-positive worker boot, readiness, heartbeat, and graceful SIGTERM shutdown all passed.

The staging-apply verification also successfully created the runtime role through `ownSys` and DBOS successfully granted privileges to `p2ci_worker`.

The remaining failure is:

```
FATAL: syntax error at or near "safe"
```

PostgreSQL received the SQL statement:

```
safe to re-apply
```

## **1\. Verified root cause**

File: `phase0/p2/setup-staging.mjs`

Current helper:

```
export function splitSqlStatements(sql) {
  if (sql.includes('$$')) {
    throw new Error('refusing to apply: schema contains dollar-quoted body (needs a real statement parser)');
  }
  const out = [];
  for (const chunk of sql.split(';')) {
    const stmt = chunk.replace(/--[^\n]*/g, '').trim();
    if (stmt.length > 0) out.push(stmt);
  }
  return out;
}
```

The implementation splits on semicolons before removing SQL comments.

The P2 schema contains:

```
-- Idempotent throughout (IF NOT EXISTS); safe to re-apply; destroys
-- nothing.
```

Splitting first produces an independent fragment containing `safe to re-apply`, which is subsequently sent to PostgreSQL as SQL.

This is a deterministic parser defect.

## **2\. Required correction**

Correct `splitSqlStatements()` so SQL line comments are removed without allowing semicolons inside comments to become statement separators.

Prefer a small lexical scanner rather than a broad regex that could corrupt quoted SQL literals.

At minimum:

* Recognize `--` line comments.  
* Ignore semicolons while inside line comments.  
* Preserve single-quoted string literals.  
* Preserve double-quoted identifiers.  
* Split only on semicolons outside quoted content and comments.  
* Trim statements and omit empty fragments.  
* Preserve the existing refusal of dollar-quoted bodies.

Handle escaped quotes correctly:

* SQL single-quote escaping: `''`.  
* SQL double-quote escaping: `""`.

Do not implement a full PostgreSQL parser or expand the scope into unrelated SQL constructs.

If the helper intentionally does not support block comments, nested comments, or other PostgreSQL lexical features, document that limitation clearly. Fail closed where unsupported constructs could result in incorrect statement execution.

## **3\. Regression tests**

Extend `phase0/p2/setup-staging.test.ts`.

Add tests proving:

1. A line comment containing multiple semicolons does not produce fragments from its contents.  
2. An inline comment containing semicolons is ignored.  
3. Semicolons inside single-quoted strings are preserved.  
4. Semicolons inside double-quoted identifiers are preserved.  
5. Escaped single and double quotes do not terminate quoted regions prematurely.  
6. The real `phase0/p2/schema.sql` produces only valid statement fragments and never emits `safe to re-apply` or other comment-only fragments.  
7. Dollar-quoted bodies still fail closed.

The most important regression must fail on the original implementation.

Do not settle for a test that merely counts the number of resulting statements. Assert the actual resulting statement contents and prove that no comment text is sent to PostgreSQL.

## **4\. Preserve existing behavior and boundaries**

Do not alter:

* Role creation via `ownSys`.  
* DBOS migration ordering.  
* The `NOLOGIN` design.  
* System/application pool separation.  
* Staging URL and database confirmation checks.  
* Application grants.  
* P3's single-transaction schema application.  
* P1/P3/backpressure behavior.  
* Ownership and teardown.  
* The new Fix A contracts and F-01 test-list correction.  
* Packaging workflow and its corrected Bash exit-code assertion.  
* Vault baseline.

Do not move P2 tables, weaken grants, or modify database schemas to work around this issue.

## **5\. Validation**

Run:

```
npm run test:phase0:unit
npm run typecheck
npx tsc -p phase0/tsconfig.json --noEmit
```

Also run focused `setup-staging.test.ts`.

The Mac does not have Docker. Do not ask the owner to install Docker or attempt a local Docker test.

Do not access `.env`, request secrets, connect to Fly or Neon, or perform staging/production operations.

Docker-backed validation must occur through GitHub Actions.

## **6\. Adversarial self-review**

Before finishing, challenge your own implementation:

* Can a semicolon in a line comment become a standalone SQL fragment?  
* Can a semicolon in a quoted string cause premature splitting?  
* Can escaped quotes cause the scanner to enter or leave the wrong state?  
* Can comment removal accidentally concatenate two SQL tokens?  
* Can a comment-only fragment reach PostgreSQL?  
* Does the real P2 schema split correctly?  
* Are dollar-quoted function bodies still rejected?  
* Is P3 still applied through its existing single-transaction path?

## **7\. Reporting and Git boundaries**

Report:

* Root cause.  
* Exact changed files.  
* Scanner behavior and explicitly unsupported SQL constructs.  
* Regression tests and proof they fail on pre-fix code.  
* Exact local validation commands and results.  
* Docker-backed tests not run locally.

Do not commit, push, merge, deploy, or mutate GitHub resources.

This is a focused parser correction, not authorization for further architecture work.

