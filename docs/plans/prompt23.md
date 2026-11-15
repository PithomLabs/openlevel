The next review should be deliberately narrow. The previous reviewer already verified M1–M5 and the earlier secondary fixes. This round should concentrate on the seven latest corrections, particularly whether the same-machine fencing fix accidentally weakens the safety checks.

# Scoped Independent Adversarial Review — OpenLevel P2 Final Remediation

## Mission

Independently review the latest remediation reported under `prompt22`.

Repository: `PithomLabs/openlevel`

Branch: `phase0/p2-staging-readiness`

Base commit:

`35254781f3753f61cda568bac4665551c589d047`

Previous independent review:

`adv_review5(3).md`

Latest implementation report:

`Remediation report — prompt22`

The previous review returned `READY FOR OWNER-MANAGED PUSH` except for one major issue (M3-R1) and several minor/informational findings.

The implementation agent reports:

- M3-R1 same-machine fencing validation corrected.
- m-R1 timestamp semantics corrected.
- m-R2 provider hold validation unified.
- m-R3 arbitration implementation shared between the validator and typed application code.
- i-R1 evidence matrix lockfile count corrected.
- i-R2 duplicate CLI arguments rejected.
- i-R3 NOT EXERCISED retry procedure clarified.
- Procedure section numbering corrected.
- Root and Phase 0 TypeScript checks passed.
- Unit tests: 271/271 across 16 files.
- No commits, pushes, or staging operations.

Your responsibility is to independently establish whether these specific corrections are sound and whether they preserve the previously approved P2 safety guarantees.

**This is a scoped review, not another full architecture review or implementation assignment.**

Do not expand the assignment into another general review of V2.1.

## 1. Repository and change integrity

Inspect:

```
git status --short
git branch --show-current
git rev-parse HEAD
git log -5 --oneline --decorate
git diff --stat
git diff 35254781f3753f61cda568bac4665551c589d047
```

Include untracked files in the review.

Confirm:

- Current branch is `phase0/p2-staging-readiness`.
- The merged base is unchanged.
- Changes correspond to prompt22.
- No unrelated user modifications were overwritten.
- No commits or pushes occurred.
- No Fly, Neon, database, Docker, production, or secret operations occurred.

Identify the exact files changed in this remediation round.

## 2. M3-R1 — Same-machine fencing validation

This is the primary review target.

Inspect:

- `phase0/p2/check-fencing.mjs`
- `phase0/p2/check-fencing.test.ts`
- `phase0/p2/generations.ts`
- `phase0/p2/arbitrate.mjs`
- `phase0/p2/arbitrate.d.mts`
- `phase0/p2/STAGING_ACCEPTANCE.md`

The reported correction excludes `replacement.bootId` from the old-generation retirement set and verifies replacement Machine-ID consistency.

Independently verify:

1. Same-machine stop-verify-start succeeds with the correct replacement boot.
2. The replacement boot itself is never classified as an old generation requiring retirement.
3. An unexpected additional fresh boot on the same Machine still fails.
4. Cross-machine replacement behavior remains correct.
5. A replacement generation with the wrong Machine ID fails.
6. Missing replacement generation fails.
7. An old active generation fails.
8. Missing or contradictory Machine-stop evidence fails.
9. A draining old worker cannot be hidden by the replacement exclusion.
10. A stale heartbeat alone cannot establish safe retirement.

Pay particular attention to the exclusion predicate.

It must exclude exactly the identified replacement boot, not all generations sharing the replacement Machine ID.

Test whether a maliciously or accidentally duplicated boot ID could conceal a separate active generation.

Review all fixtures, not just the happy path.

The central invariant remains:

**A replacement executor may be considered safe only after the previous executor's Machine has been authoritatively observed stopped and its generation has been verified inactive.**

A passing transcript validator must not weaken this invariant.

## 3. m-R1 — Timestamp and event-order semantics

Inspect the new five-event transcript model.

The required events are:

1. Stop requested.
2. Fly Machine observed stopped.
3. Old generation verified inactive.
4. Replacement start requested.
5. Replacement generation observed ready.

Verify that:

- All canonical events are required.
- Event sequence numbers are unique and strictly ordered.
- The monotonic clock belongs to one collector and one coherent observation sequence.
- Missing, duplicate, reordered, contradictory, or backward events fail.
- Machine IDs and boot IDs remain consistent throughout.
- The replacement cannot appear before the old Machine's stopped observation.
- DB and Fly timestamps remain supporting evidence rather than being compared as synchronized clocks without justification.
- Malformed or incomplete transcripts fail closed.

Determine whether the event sequence represents actual observations or merely operator-supplied assertions.

A transcript that allows an operator to fabricate the required order without underlying Fly and database evidence is not sufficient.

The acceptance documentation must identify the exact fields, commands, and evidence sources.

## 4. m-R2 — Provider hold validation

Inspect the shared `probeHoldMs(env, variableName)` implementation and its use by both:

- `P2_NORMAL_HOLD_MS`
- `P2_PROVIDER_DELAY_MS`

Verify:

- Both variables use exactly the same validation rules.
- Default values are deliberate and documented.
- Zero behavior is explicit.
- Negative values fail.
- Fractional values fail if the contract requires integers.
- NaN and Infinity fail.
- Values above the maximum fail.
- Malformed strings fail.
- Invalid configuration cannot silently disable a required hold.
- The maximum is bounded and appropriate for the staging acceptance procedure.

Run the boundary tests and inspect the actual workflow configuration.

Confirm that the provider hold cannot accidentally be omitted because of an invalid environment variable.

## 5. m-R3 — One authoritative replacement-arbitration implementation

Inspect:

- `phase0/p2/arbitrate.mjs`
- `phase0/p2/arbitrate.d.mts`
- `phase0/p2/generations.ts`
- `phase0/p2/check-fencing.mjs`
- Related tests.

Verify that the same authoritative implementation governs both the typed application code and the transcript validator.

Check:

- Runtime module resolution.
- ESM import behavior.
- Type declaration accuracy.
- No stale duplicated decision logic.
- No circular dependency.
- No different default behavior between the two entrypoints.

Execute the consistency tests using identical fixtures against both entrypoints.

Required classifications remain:

- Running or stopping → BLOCKED.
- Fresh draining → potentially active, BLOCKED.
- Stopped and consistent → SAFE.
- Unavailable or contradictory → BLOCKED.
- Stale heartbeat alone → insufficient for retirement.

A shared module that is imported by both paths but bypassed in one decision branch does not satisfy this requirement.

## 6. i-R1 — Evidence matrix lockfile count

Verify the actual diff between the relevant lockfile versions.

Confirm the matrix accurately reports:

- Addition count.
- Deletion count.
- No hash changes, if supported by the actual diff.
- No dependency version or resolved URL changes, if supported by the actual diff.

Do not accept copied or manually asserted counts.

## 7. i-R2 — Duplicate CLI argument handling

Inspect the shared argument parser and all four operator CLIs.

Verify:

- Duplicate options are rejected.
- Boolean flags cannot silently consume values.
- Bare flags are rejected where values are required.
- Unknown flags fail.
- Unsupported queues fail.
- Duplicate values cannot create inconsistent execution parameters.
- All four commands use the same parser implementation.

Pay particular attention to whether duplicate detection happens before the last value overwrites the first.

Run the parser tests.

## 8. i-R3 — NOT EXERCISED retry semantics

Inspect the updated staging acceptance procedure.

Verify:

- NOT EXERCISED is not reported as PASS or ordinary FAIL.
- The read-only gate can be retried without enqueuing another workflow.
- Retrying uses the same identified workflow and operation.
- Expired holds do not cause new provider dispatch.
- A new run tag is permitted only after the previous operation is demonstrably complete or safely quarantined.
- No retry path can create a second provider acceptance.
- The procedure does not require the operator to repeat irreversible steps to obtain evidence.

Check that the documentation's retry sequence matches the actual CLI behavior.

## 9. Preserve previously approved findings

This review should not repeat the full prompt21 audit, but verify that the new changes have not regressed its accepted corrections.

Perform focused regression checks for:

- M1: production-only dependency packaging and actual image-build CI job.
- M2: P2/P3 staging schema installation, schema placement, and restricted worker-role permissions.
- M4: PostgreSQL `UNIQUE(operation_id)` and independently committed provider acceptance.
- M5: in-flight workflow gate and bounded holds.
- m1: strict argument validation.
- m2: restricted worker privileges.
- i2: freshness-aware Machine/generation arbitration.

Pay particular attention to shared parser and arbitration changes.

Verify that:

- P1 atomic enqueue remains untouched.
- P3 default behavior remains unchanged.
- Backpressure remains untouched.
- Existing integration CI jobs remain intact.
- The known vault baseline is preserved.

The only P3 change permitted is the previously reviewed additive provider seam.

## 10. Validation

Run the safe checks where available:

```
npm run typecheck
npx tsc -p phase0/tsconfig.json --noEmit
npm run test:phase0:unit
```

Expected reported result:

**271/271 unit tests across 16 files.**

Independently verify the actual test output and per-file counts.

Also inspect:

- Shell syntax.
- Workflow YAML.
- Fencing transcript fixtures.
- Hold-parser boundaries.
- Shared-arbitration consistency.
- Git diff against the merged base.
- Secret scan.

Do not run Docker locally.

Do not access `.env`.

Do not run Fly or Neon commands.

Do not perform database or cloud operations.

Do not modify any files.

## 11. Findings and severity

Classify findings as:

**CRITICAL:** The fix permits concurrent executors, hides an active generation, permits duplicate provider acceptance, or exposes credentials.

**MAJOR:** The fencing validator can falsely pass, cannot pass a legitimate transcript, timestamp semantics are unsound, the shared arbitration paths diverge, or an operator retry can cause an unintended dispatch.

**MINOR:** Bounded correctness or usability defect with no compromise of the core safety guarantees.

**INFO:** Documentation or maintainability improvement.

For every finding provide:

- Exact file and line.
- Root cause.
- Concrete failure scenario.
- Impact.
- Evidence classification.
- Smallest durable correction.
- Required regression test.

Distinguish code-proven behavior, unit-test behavior, CI-only proof, and staging-only proof.

## 12. Final verdict

Choose exactly one:

**READY FOR OWNER-MANAGED PUSH**

All scoped corrections are sound, no unresolved CRITICAL or MAJOR finding remains, and previously accepted P2 guarantees are preserved.

**FIX BEFORE PUSH**

A material defect remains.

**BLOCKED — INSUFFICIENT EVIDENCE**

A critical property cannot be established from the available code and tests.

A READY verdict authorizes owner publication and GitHub CI review only.

It does not mean P2 staging acceptance has passed and does not authorize Fly/Neon deployment.

The actual T1–T6 staging tests remain BLOCKED until separately authorized and executed.

## 13. Final report format

A. Executive verdict.

B. M3-R1 same-machine fencing.

C. m-R1 timestamp semantics.

D. m-R2 provider hold validation.

E. m-R3 shared arbitration.

F. i-R1 matrix correction.

G. i-R2 duplicate CLI arguments.

H. i-R3 NOT EXERCISED retry.

I. Regression preservation of M1–M5 and P1/P3/backpressure.

J. Validation results.

K. Exact remaining owner action.

Do not recommend another broad review unless this scoped review uncovers a genuine structural defect.

Guiding principle:

**Fix the cause, strengthen the system, and prove the solution—not merely silence the error.**

## **Recommendation**

This should be the last independent code review before publication, provided it returns `READY FOR OWNER-MANAGED PUSH`.

The following sequence remains unchanged: manual publication, PR checks, CodeRabbit review, and then separately authorized Fly/Neon staging acceptance. T1–T6 are not passed merely because the code-side harness is ready.