import type { TriggerType } from '../lib/automation-vocab'
import type { WorkflowRun } from '../repos/workflow-runs-repo'
import { WorkflowsRepo } from '../repos/workflows-repo'
import { type WorkflowRunnerDeps, runWorkflow } from './workflow-runner'

/**
 * A real thing that happened in a location — a contact was created, a message
 * came in, an opportunity opened. The dispatcher turns it into workflow runs.
 */
export interface WorkflowEvent {
  locationId: string
  triggerType: TriggerType
  contactId: string | null
  /**
   * Stable identity for this logical event (FIND-07). Minted ONCE at the
   * creation site (route/handler) via randomUUID — never per retry or per
   * delivery — so redeliveries of the same job data deduplicate instead of
   * re-executing. HTTP-level retries get their own key (idempotency layer);
   * this key covers queue delivery and crash-recovery replays.
   */
  eventId: string
}

/**
 * What a route calls when something happens that workflows can trigger on. In
 * prod this enqueues a `workflow.dispatch` pg-boss job (durable, off the request
 * path); in dev/tests it runs the dispatch in-process. Routes depend on this
 * shape, not on pg-boss, so they stay pure.
 */
export type WorkflowDispatch = (event: WorkflowEvent) => void | Promise<void>

/**
 * Fan one event out to every live workflow wired to that trigger, starting an
 * honest run for each. Draft workflows are ignored (only `status = 'live'`
 * fires). Returns the runs it started so callers/tests can inspect them; an
 * event with no matching live workflow is a no-op that returns `[]`.
 *
 * Runs are started sequentially to keep ordering deterministic and avoid a
 * thundering herd on the shared DB; each run is itself cheap (a handful of
 * scoped queries) and a `wait` step defers via the scheduler rather than
 * blocking here.
 */
export async function dispatchWorkflowEvent(
  deps: WorkflowRunnerDeps,
  event: WorkflowEvent,
): Promise<WorkflowRun[]> {
  const live = await new WorkflowsRepo(deps.db, event.locationId).listLiveByTrigger(
    event.triggerType,
  )

  const runs: WorkflowRun[] = []
  for (const workflow of live) {
    // FIND-07: claim (event, workflow) atomically before running. A duplicate
    // delivery — boss redelivery, crash-retry, or the outbox sweeper firing
    // alongside the fast path — loses the INSERT race and skips instead of
    // re-executing. Known edge: a crash between claim and run completion
    // strands that run's tail (its workflow_runs row stays 'running', visible
    // to the operator); a runs-reaper is future work, not silent duplication.
    const claimed = await deps.db.query<{ event_id: string }>(
      `INSERT INTO processed_events (location_id, event_id, workflow_id, trigger_type)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING
       RETURNING event_id`,
      [event.locationId, event.eventId, workflow.id, event.triggerType],
    )
    if (claimed.length === 0) continue
    runs.push(
      await runWorkflow(deps, {
        locationId: event.locationId,
        workflowId: workflow.id,
        contactId: event.contactId,
        triggerType: event.triggerType,
      }),
    )
  }
  return runs
}
