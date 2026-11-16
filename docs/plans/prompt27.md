# **Prompt 27 — Fix P2 Ledger-Race CI Cleanup Parameter Binding**

## **Objective**

Fix the deterministic PostgreSQL parameter-binding failure in `phase0/p2/ci-ledger-race.mjs` discovered in GitHub Actions run `43748829440`.

The race proof already demonstrates the intended database behavior. Preserve that proof and correct only the cleanup defect.

## **Evidence**

The failed CI job reports:

```
RACE-OK contender-blocks-on-uncommitted-acceptance
RACE-OK loser-gets-unique-violation — code=23505
RACE-OK exactly-one-acceptance-after-race
RACE-OK sequential-double-accept-rejected — code=23505
FATAL: there is no parameter $1
```

PostgreSQL identifies the failing statement:

```
DELETE FROM app.p2_provider_ledger WHERE operation_id = $1
```

The statement is executed without a corresponding parameter array.

## **Required change**

In `phase0/p2/ci-ledger-race.mjs`, change the cleanup call to bind the existing `op` variable:

```
await observer.query(
  `DELETE FROM app.p2_provider_ledger WHERE operation_id = $1`,
  [op],
);
```

Do not hardcode the operation ID.

## **Required review**

1. Inspect the entire script for other parameterized SQL statements that omit their corresponding parameter arrays.  
2. Confirm that the operation ID used for cleanup is exactly the one generated for this test run.  
3. Confirm cleanup remains in the existing `try/finally` lifecycle and does not alter the race ordering.  
4. Confirm no unrelated production or staging setup code has changed.

## **Validation**

Run:

* The ledger-race proof against real PostgreSQL.  
* The proof repeatedly, to ensure the concurrent race remains deterministic.  
* Phase 0 unit tests.  
* Root and Phase 0 TypeScript checks.  
* Relevant integration checks.

The developer's Mac does not have Docker. Do not ask them to install Docker. Docker-backed validation must run in GitHub Actions.

## **Adversarial checks**

Verify that:

* The proof still observes the contender waiting on the first transaction.  
* The losing insert still receives `23505`.  
* Exactly one accepted ledger entry remains after the race.  
* Sequential duplicate acceptance still receives `23505`.  
* Cleanup removes only the test operation's ledger record.  
* The script exits successfully after cleanup.

## **Constraints**

* Modify only `phase0/p2/ci-ledger-race.mjs` unless a demonstrable defect requires another change.  
* Do not weaken or remove any race assertion.  
* Do not replace the database race with a mocked test.  
* Do not change the unique constraint or ledger schema.  
* Do not modify P3, worker boot, staging setup, grants, or deployment configuration.  
* Do not access Fly.io, Neon staging, or production.  
* Do not commit or push.

## **Deliverable**

Report the exact diff, validation commands and results, and any remaining limitations. Stop for independent adversarial review before publication.

