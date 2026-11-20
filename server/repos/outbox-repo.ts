import { LocationScopedRepo } from './base-repo'

export interface OutboxRecord {
  id: string
  location_id: string
  aggregate: string
  aggregate_id: string
  event: string
  payload: Record<string, unknown>
  status: string
  attempts: number
  available_at: string
}

export interface OutboxInput {
  /** Stable caller-derived id (e.g. `booking:<appointment_id>`): re-insertion
   *  of the same intent is a no-op, so retries never double-queue. */
  id: string
  aggregate: string
  aggregateId: string
  event: string
  payload?: Record<string, unknown>
}

/**
 * Transactional outbox (FIND-07). Business transactions insert their dispatch
 * intents here; the relay (server/jobs/outbox-relay.ts) delivers them. Crash
 * between commit and enqueue degrades to delayed delivery, never loss — and
 * the dispatcher's processed_events claim keeps redelivery side-effect-free.
 */

/** Stale horizon shared by discovery + claim: one constant, one rule. */
export const OUTBOX_STALE_AFTER_MS = 300_000

/**
 * Shared recoverability predicate (R13-04): a row is due when pending, or
 * when stuck in `sending` past the stale horizon (crashed relay). The
 * sweeper's location discovery and the per-location claim both spell this
 * rule through this builder, so the two can never silently diverge again
 * (a stale-only location going invisible to the sweeper).
 */
export function outboxRecoverableClause(staleSecsParam: string): string {
  return `(status = 'pending' OR (status = 'sending' AND updated_at < now() - make_interval(secs => ${staleSecsParam}))) AND available_at <= now()`
}

export class OutboxRepo extends LocationScopedRepo {
  async insert(input: OutboxInput): Promise<void> {
    await this.db.query(
      `INSERT INTO outbox (id, location_id, aggregate, aggregate_id, event, payload)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO NOTHING`,
      [input.id, this.locationId, input.aggregate, input.aggregateId, input.event, input.payload ?? {}],
    )
  }

  /**
   * Claim up to `limit` due rows for delivery: pending rows plus rows stuck
   * in sending past the stale horizon (crashed relay). SKIP LOCKED lets
   * concurrent relays divide work instead of blocking. The caller MUST run
   * this inside withTransaction (the claim commits with the caller).
   */
  async claimDue(limit: number, staleAfterMs: number): Promise<OutboxRecord[]> {
    return this.db.query<OutboxRecord>(
      `UPDATE outbox SET status = 'sending', updated_at = now()
       WHERE id IN (
         SELECT id FROM outbox
         WHERE location_id = $1
           AND ${outboxRecoverableClause('$3')}
         ORDER BY available_at
         LIMIT $2
         FOR UPDATE SKIP LOCKED
       )
       RETURNING *`,
      [this.locationId, limit, staleAfterMs / 1000],
    )
  }

  async markSent(id: string): Promise<void> {
    await this.db.query(`UPDATE outbox SET status = 'sent', updated_at = now() WHERE id = $1 AND location_id = $2`, [
      id,
      this.locationId,
    ])
  }

  /**
   * Distinct locations holding recoverable rows, for the sweeper fan-out:
   * pending-due rows AND stale `sending` rows eligible for reclaim (same
   * predicate the claim uses — R13-04). Location filter is applied by the
   * caller (drainOutbox), not here. Despite the legacy name, this is not
   * pending-only: renaming would churn every caller for no behavior gain.
   */
  static async locationsWithPending(
    db: { query<T>(sql: string, params?: unknown[]): Promise<T[]> },
    staleAfterMs: number = OUTBOX_STALE_AFTER_MS,
  ): Promise<string[]> {
    const rows = await db.query<{ location_id: string }>(
      `SELECT DISTINCT location_id FROM outbox WHERE ${outboxRecoverableClause('$1')}`,
      [staleAfterMs / 1000],
    )
    return rows.map((r) => r.location_id)
  }

  /**
   * Record a failed delivery attempt: back off (attempts × 60s) while attempts
   * remain, else park as failed for operator inspection. Never silently drops.
   */
  async markFailed(id: string, maxAttempts = 5): Promise<void> {
    await this.db.query(
      `UPDATE outbox
       SET attempts = attempts + 1,
           status = CASE WHEN attempts + 1 >= $3 THEN 'failed' ELSE 'pending' END,
           available_at = CASE WHEN attempts + 1 >= $3 THEN available_at ELSE now() + make_interval(secs => (attempts + 1) * 60) END,
           updated_at = now()
       WHERE id = $1 AND location_id = $2`,
      [id, this.locationId, maxAttempts],
    )
  }
}
