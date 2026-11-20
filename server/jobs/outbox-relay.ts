import type { Database } from '../db/database'
import type { TriggerType } from '../lib/automation-vocab'
import { OUTBOX_STALE_AFTER_MS, OutboxRepo } from '../repos/outbox-repo'
import { type WorkflowDispatch } from './workflow-dispatcher'

/**
 * Outbox relay (FIND-07): delivers transactional dispatch intents written by
 * business transactions. Runs on a boss cron schedule (see registerOutboxSweep
 * in boss.ts) and after any code path that wants prompt delivery.
 *
 * Each claimed row dispatches exactly the event the transaction recorded; the
 * dispatcher's processed_events claim makes sweeper-vs-fast-path double
 * delivery safe. A throwing dispatch parks the row for retry with backoff
 * (OutboxRepo.markFailed) rather than losing or duplicating it.
 */
export interface DbosWorkflowIntent {
  contactId: string
  operationId: string
  delayMs: number
}

export async function drainOutbox(
  db: Database,
  locationId: string,
  dispatch: WorkflowDispatch,
  opts: {
    limit?: number
    staleAfterMs?: number
    /** DBOS starter for `dbos_workflow` rows (pilot). Absent => those rows park for retry, never silently drop. */
    startDbosWorkflow?: (locationId: string, intent: DbosWorkflowIntent) => Promise<unknown>
  } = {},
): Promise<{ sent: number; failed: number }> {
  const repo = new OutboxRepo(db, locationId)
  const claimed = await db.withTransaction(async (tx) => {
    const scoped = new OutboxRepo(tx, locationId)
    return scoped.claimDue(opts.limit ?? 25, opts.staleAfterMs ?? OUTBOX_STALE_AFTER_MS)
  })
  let sent = 0
  let failed = 0
  for (const row of claimed) {
    try {
      if (row.aggregate === 'dbos_workflow') {
        if (!opts.startDbosWorkflow) throw new Error('dbos workflow starter not wired')
        const payload = row.payload as Record<string, unknown>
        if (
          typeof payload.contactId !== 'string' ||
          typeof payload.operationId !== 'string' ||
          typeof payload.delayMs !== 'number'
        ) {
          throw new Error('malformed dbos workflow intent')
        }
        await opts.startDbosWorkflow(locationId, {
          contactId: payload.contactId,
          operationId: payload.operationId,
          delayMs: payload.delayMs,
        })
      } else {
        await dispatch({
          locationId,
          triggerType: row.event as TriggerType,
          contactId: (row.payload.contactId as string | null) ?? null,
          eventId: row.id,
        })
      }
      await repo.markSent(row.id)
      sent += 1
    } catch {
      await repo.markFailed(row.id)
      failed += 1
    }
  }
  return { sent, failed }
}
