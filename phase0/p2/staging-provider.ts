/**
 * P2 staging provider simulation (addendum §3). A fake provider whose
 * acceptance is durable in the staging database — NOT a local file —
 * so the acceptance survives worker termination by construction.
 *
 * Transactional separation (the load-bearing property): the provider
 * commits its acceptance in its OWN transaction (single autocommitted
 * INSERT), independently of the application attempt record. Committing
 * both in one transaction would invalidate the experiment, because a
 * crash could then never separate "provider accepted" from "worker
 * recorded the response".
 *
 * Required staging sequence:
 *   1. Application persists attempt as dispatching (P3 dispatchAttempt
 *      pre-dispatch gate) and commits it.
 *   2. Staging provider accepts the operation and commits the ledger row.
 *   3. Operator terminates the worker before it persists the response.
 *   4. Replacement worker recovers: the attempt is uncertain/stale AND
 *      the ledger already holds an acceptance → redispatch REFUSED.
 *   5. Acceptance evidence: exactly one ledger row per operation_id.
 *
 * Invariant: one business operation, one accepted provider operation,
 * regardless of worker crashes or lost responses.
 */
import type { Pool } from 'pg';
import { ProviderTimeoutError, type ProviderResult } from '../p3/fake-provider.js';
import { ConflictError, type ProviderFn } from '../p3/wallet.js';

export interface LedgerAcceptance {
  operation_id: string;
  attempt_id: string;
}

/**
 * Pure redispatch decision: an operation with ANY prior provider
 * acceptance must never be dispatched again. Unit-tested.
 */
export function redispatchAllowed(acceptances: LedgerAcceptance[], operationId: string): boolean {
  return !acceptances.some((a) => a.operation_id === operationId);
}

/**
 * Refuse dispatch when the provider ledger already accepted this
 * operation. Throws ConflictError naming the evidence; passes silently
 * when no acceptance exists. The `pool` is the application pool.
 */
export async function assertNoPriorAcceptance(pool: Pool, operationId: string): Promise<void> {
  const r = await pool.query(`SELECT attempt_id AS attempt_id FROM app.p2_provider_ledger WHERE operation_id = $1`, [
    operationId,
  ]);
  const rows = r.rows as Array<{ attempt_id: string }>;
  if (rows.length > 0) {
    throw new ConflictError(
      `refusing redispatch: provider already accepted operation ${operationId} ` +
        `(attempt ${rows[0]?.attempt_id}, ${rows.length} acceptance(s)) — inspect before dispatching`,
    );
  }
}

/** Count ledger acceptances for exactly-one assertions (evidence queries). */
export async function countAcceptances(pool: Pool, operationId: string): Promise<number> {
  const r = await pool.query(`SELECT count(*)::int AS n FROM app.p2_provider_ledger WHERE operation_id = $1`, [
    operationId,
  ]);
  return (r.rows[0] as { n: number }).n;
}

export interface StagingProviderOptions {
  /** Post-acceptance hold (ms) so T3 can terminate the worker mid-call. Probe-only test control, never production sync. */
  holdAfterAcceptMs?: number;
  /** After committing acceptance, throw ProviderTimeoutError (lost response) instead of returning. Models T2-case-3. */
  timeoutAfterAccept?: boolean;
}

/**
 * Create the staging fake provider: accepts into app.p2_provider_ledger
 * in its own committed transaction, then optionally holds the response
 * open for kill-window tests. Post-accept ambiguity surfaces as
 * ProviderTimeoutError (quarantined by P3 dispatchAttempt); the ledger
 * row is what makes recovery inspectable instead of blind.
 *
 * Contention: UNIQUE(operation_id) arbitrates concurrent acceptances.
 * A 23505 loser is translated to an explicit ConflictError (never a
 * second acceptance, never a silent swallow); P3 marks that attempt
 * failed-before-acceptance and the probe records contention-lost.
 */
export function createLedgerProvider(pool: Pool, opts: StagingProviderOptions = {}): ProviderFn {
  return async (args): Promise<ProviderResult> => {
    try {
      await pool.query(`INSERT INTO app.p2_provider_ledger (operation_id, attempt_id) VALUES ($1, $2)`, [
        args.operationId,
        args.attemptId,
      ]);
    } catch (err) {
      if (typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505') {
        throw new ConflictError(
          `provider already accepted operation ${args.operationId} (contending attempt ${args.attemptId} loses)`,
        );
      }
      throw err;
    }
    if (opts.timeoutAfterAccept) {
      throw new ProviderTimeoutError(args.attemptId);
    }
    if ((opts.holdAfterAcceptMs ?? 0) > 0) {
      await new Promise((res) => setTimeout(res, opts.holdAfterAcceptMs));
    }
    return {
      attemptId: args.attemptId,
      requestId: `p2-ledger-${args.attemptId}`,
      inputTokens: args.inputTokens,
      outputTokens: args.outputTokens,
    };
  };
}
