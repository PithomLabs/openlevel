import { nanoid } from 'nanoid'
import { LocationScopedRepo } from './base-repo'
import type { WaitContinuation } from '../jobs/workflow-runner'

export interface WorkflowWait {
  id: string
  location_id: string
  run_id: string
  workflow_id: string
  contact_id: string | null
  trigger_type: string
  from_position: number
  due_at: string
  definition_hash: string
  status: string
  attempts: number
}

/** Resume attempts past this count mark the wait failed (poison-pill bound). */
export const MAX_RESUME_ATTEMPTS = 25

/**
 * Durable wait continuations (FIND-06). A wait step persists its full resume
 * state here; a delayed boss job (or the boot reaper) picks it up at due_at.
 * Claims are atomic single UPDATEs: concurrent resume deliveries collapse to
 * exactly one owner, and the partial unique index forbids two live rows that
 * could resume the same run twice.
 */
export class WorkflowWaitsRepo extends LocationScopedRepo {
  async persist(continuation: WaitContinuation): Promise<WorkflowWait> {
    const id = nanoid()
    const rows = await this.scopedWrite<WorkflowWait>(
      `INSERT INTO workflow_waits
         (id, location_id, run_id, workflow_id, contact_id, trigger_type, from_position, due_at, definition_hash)
       VALUES ($2,$1,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [
        id,
        continuation.runId,
        continuation.workflowId,
        continuation.contactId,
        continuation.triggerType,
        continuation.fromPosition,
        continuation.dueAt.toISOString(),
        continuation.definitionHash,
      ],
    )
    return rows[0]!
  }

  /**
   * Claim one wait for execution: pending rows at/after due time, plus rows
   * stuck claimed past the stale horizon (crashed worker). SKIP LOCKED lets
   * concurrent resumers divide work. Returns the claimed row or undefined.
   */
  async claimOne(waitId: string, claimedBy: string, staleAfterMs: number): Promise<WorkflowWait | undefined> {
    const rows = await this.scopedWrite<WorkflowWait>(
      `UPDATE workflow_waits SET status = 'claimed', claimed_by = $3, claimed_at = now(),
         attempts = attempts + 1, updated_at = now()
       WHERE location_id = $1 AND id = $2
         AND ((status = 'pending' AND due_at <= now())
           OR (status = 'claimed' AND claimed_at < now() - make_interval(secs => $4)))
       RETURNING *`,
      [waitId, claimedBy, staleAfterMs / 1000],
    )
    return rows[0]
  }

  async markCompleted(waitId: string): Promise<void> {
    await this.scopedWrite(
      `UPDATE workflow_waits SET status = 'completed', updated_at = now() WHERE location_id = $1 AND id = $2`,
      [waitId],
    )
  }

  async markFailed(waitId: string): Promise<void> {
    await this.scopedWrite(
      `UPDATE workflow_waits SET status = 'failed', updated_at = now() WHERE location_id = $1 AND id = $2`,
      [waitId],
    )
  }

  async markCancelled(waitId: string): Promise<void> {
    await this.scopedWrite(
      `UPDATE workflow_waits SET status = 'cancelled', updated_at = now() WHERE location_id = $1 AND id = $2`,
      [waitId],
    )
  }

  /**
   * Wait ids whose delayed job evidently never arrived: pending and past due
   * by more than the grace window (normal just-due rows belong to their live
   * delayed job, not the reaper). Bounded for one sweep pass.
   */
  static async overdueIds(
    db: { query<T>(sql: string, params?: unknown[]): Promise<T[]> },
    graceMs: number,
    staleClaimMs: number,
    limit = 100,
  ): Promise<{ id: string; location_id: string }[]> {
    // Overdue pending rows (delayed job never arrived) plus stale claimed
    // rows (worker died mid-resume). A concurrent live resume holds a fresh
    // claim, so re-enqueueing here converges via claimOne, never duplicates.
    return db.query<{ id: string; location_id: string }>(
      `SELECT id, location_id FROM workflow_waits
       WHERE (status = 'pending' AND due_at < now() - make_interval(secs => $1))
          OR (status = 'claimed' AND claimed_at < now() - make_interval(secs => $2))
       ORDER BY due_at LIMIT $3`,
      [graceMs / 1000, staleClaimMs / 1000, limit],
    )
  }
}
