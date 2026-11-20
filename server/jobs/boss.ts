import { PgBoss } from 'pg-boss'
import type { Database } from '../db/database'
import { OUTBOX_STALE_AFTER_MS, OutboxRepo } from '../repos/outbox-repo'
import { WorkflowRunsRepo } from '../repos/workflow-runs-repo'
import { MAX_RESUME_ATTEMPTS, WorkflowWaitsRepo } from '../repos/workflow-waits-repo'
import { WorkflowActionsRepo } from '../repos/workflow-actions-repo'
import { WorkflowsRepo } from '../repos/workflows-repo'
import { type AgentReplyDeps, type AgentReplyPayload, handleAgentReply } from './agent-reply'
import { drainOutbox } from './outbox-relay'
import { type WorkflowDispatch, type WorkflowEvent, dispatchWorkflowEvent } from './workflow-dispatcher'
import { type ScheduleWait, type WorkflowRunnerDeps, definitionHash, runWorkflow } from './workflow-runner'

export const AGENT_REPLY_QUEUE = 'agent.reply.dispatch'
export const WORKFLOW_DISPATCH_QUEUE = 'workflow.dispatch'
export const OUTBOX_SWEEP_QUEUE = 'outbox.sweep'
export const WORKFLOW_RESUME_QUEUE = 'workflow.resume'
/** The sweeper cadence: crash-to-redelivery latency for orphaned intents. */
export const OUTBOX_SWEEP_CRON = '* * * * *'

// Where a job lands once it has exhausted every retry. pg-boss copies the failed
// job's payload here instead of letting it vanish, so a reply or automation that
// could not be delivered is preserved for an operator to inspect and requeue —
// the opposite of GoHighLevel quietly dropping a failed AI action.
export const AGENT_REPLY_DLQ = 'agent.reply.dead'
export const WORKFLOW_DISPATCH_DLQ = 'workflow.dispatch.dead'
export const OUTBOX_SWEEP_DLQ = 'outbox.sweep.dead'
export const WORKFLOW_RESUME_DLQ = 'workflow.resume.dead'

/**
 * Retry policy for jobs that call out to a flaky dependency — the Anthropic API,
 * Chatwoot, our own database. pg-boss defaults to retryLimit 2 with retryDelay 0,
 * i.e. an *immediate* retry. That is exactly wrong for a 429 (rate limited) or 529
 * (overloaded) from the model API: an instant retry re-hits the same limit within
 * milliseconds and burns both attempts, so a momentary hiccup loses the customer's
 * reply. Exponential backoff with jitter (retryBackoff) spaces the attempts out so
 * a transient blip recovers; retryDelayMax caps the wait so a reply is never
 * delayed by more than a few minutes; and the queue's dead-letter target keeps the
 * payload if every attempt still fails.
 */
export const RESILIENT_RETRY = {
  retryLimit: 4,
  retryDelay: 5,
  retryBackoff: true,
  retryDelayMax: 300,
} as const

// One job per fetch. With a batch, a single throw fails the whole batch in
// pg-boss; at batchSize 1 a throw fails *only* that job, which then retries with
// the backoff policy above and never takes its neighbours down with it. Kept
// explicit so the invariant cannot silently drift if a default changes.
export const SINGLE_JOB = { batchSize: 1 } as const

/**
 * Create every queue this app uses, each with its durability policy. The
 * dead-letter queues are created first because a queue's `deadLetter` must name a
 * queue that already exists. Split out from `startBoss` so the wiring (does the
 * backoff policy actually reach createQueue?) is unit-testable against a fake boss.
 *
 * DRIFT WARNING: pg-boss `createQueue` is create-only — it never updates an
 * existing queue's options. Changing RESILIENT_RETRY / deadLetter / SINGLE_JOB
 * in code does NOT apply to queues that already exist in the database; reconcile
 * out-of-band (drop + recreate the queue during a maintenance window, or update
 * the pgboss schema row directly) and note it in the release evidence.
 */
export async function ensureQueues(boss: Pick<PgBoss, 'createQueue'>): Promise<void> {
  await boss.createQueue(AGENT_REPLY_DLQ)
  await boss.createQueue(WORKFLOW_DISPATCH_DLQ)
  await boss.createQueue(OUTBOX_SWEEP_DLQ)
  await boss.createQueue(WORKFLOW_RESUME_DLQ)
  await boss.createQueue(AGENT_REPLY_QUEUE, { ...RESILIENT_RETRY, deadLetter: AGENT_REPLY_DLQ })
  await boss.createQueue(WORKFLOW_DISPATCH_QUEUE, { ...RESILIENT_RETRY, deadLetter: WORKFLOW_DISPATCH_DLQ })
  await boss.createQueue(OUTBOX_SWEEP_QUEUE, { ...RESILIENT_RETRY, deadLetter: OUTBOX_SWEEP_DLQ })
  await boss.createQueue(WORKFLOW_RESUME_QUEUE, { ...RESILIENT_RETRY, deadLetter: WORKFLOW_RESUME_DLQ })
}

/** Start pg-boss against DATABASE_URL and ensure our queues exist. */
export async function startBoss(connectionString: string): Promise<PgBoss> {
  const boss = new PgBoss({ connectionString })
  await boss.start()
  await ensureQueues(boss)
  return boss
}

/** Register the worker that runs handleAgentReply for each queued job. A throw
 *  from the handler (a model/DB failure) fails just this one job, which pg-boss
 *  then retries with backoff; handleAgentReply turns its *expected* dead ends
 *  (no key, unknown location) into a `skipped` return so they complete cleanly
 *  rather than burning retries. The processed_events claim (FIND-07) makes a
 *  redelivered job a no-op instead of a second draft. */
export async function registerAgentReplyWorker(boss: PgBoss, deps: AgentReplyDeps): Promise<void> {
  await boss.work<AgentReplyPayload>(AGENT_REPLY_QUEUE, SINGLE_JOB, async (jobs) => {
    for (const job of jobs) {
      const claimed = await deps.db.query<{ event_id: string }>(
        `INSERT INTO processed_events (location_id, event_id, workflow_id, trigger_type)
         VALUES ($1, $2, 'agent-reply', 'inbound_message')
         ON CONFLICT DO NOTHING
         RETURNING event_id`,
        [job.data.locationId, job.data.messageId],
      )
      if (claimed.length === 0) continue // redelivery: this message already got its reply pass
      await handleAgentReply(deps, job.data)
    }
  })
}

/**
 * Enqueue an agent-reply job — called by the webhook's onInbound hook. The
 * message id rides as the singleton key (double-enqueue collapses); the
 * worker's processed_events claim is the durable second layer.
 */
export async function enqueueAgentReply(boss: PgBoss, payload: AgentReplyPayload): Promise<void> {
  await boss.send(AGENT_REPLY_QUEUE, payload, {
    singletonKey: `ar:${payload.locationId}:${payload.messageId}`,
  })
}

/**
 * Register the worker that fans a workflow event out to its live workflows. Each
 * job runs `dispatchWorkflowEvent`, which starts one run per matching workflow.
 * Runs use the runner's default scheduler for `wait` steps (in-process timers);
 * making long waits survive a restart is a later refinement (the runner already
 * supports resume via runId + fromPosition — it's a scheduler swap, not a rewrite).
 */
export async function registerWorkflowDispatchWorker(
  boss: PgBoss,
  deps: WorkflowRunnerDeps,
): Promise<void> {
  // Production workers run every dispatch with the durable wait backend, so
  // waits encountered here persist instead of arming in-process timers.
  const runnerDeps: WorkflowRunnerDeps = { ...deps, scheduleWait: createDurableWaitScheduler(boss, deps.db) }
  await boss.work<WorkflowEvent>(WORKFLOW_DISPATCH_QUEUE, SINGLE_JOB, async (jobs) => {
    for (const job of jobs) {
      await dispatchWorkflowEvent(runnerDeps, job.data)
    }
  })
}

export interface OutboxSweepDeps {
  db: Database
  dispatch: WorkflowDispatch
}

/**
 * Register the outbox sweeper (FIND-07): a cron worker that drains stale
 * dispatch intents orphaned by crashes between commit and enqueue. The
 * dispatcher's processed_events claim keeps sweeper-vs-fast-path double
 * delivery side-effect-free, so the sweeper is safe to overlap real traffic.
 */
export async function registerOutboxSweeper(boss: PgBoss, deps: OutboxSweepDeps): Promise<void> {
  await boss.work(OUTBOX_SWEEP_QUEUE, SINGLE_JOB, async () => {
    // Same stale horizon the drain claims with — discovery and claim agree.
    const locations = await OutboxRepo.locationsWithPending(deps.db, OUTBOX_STALE_AFTER_MS)
    for (const locationId of locations) {
      await drainOutbox(deps.db, locationId, deps.dispatch)
    }
  })
  await boss.schedule(OUTBOX_SWEEP_QUEUE, OUTBOX_SWEEP_CRON)
}

/**
 * Enqueue a workflow event — called by routes/webhooks when a trigger fires.
 * The stable event_id rides as the boss singleton key so a double-enqueue of
 * the same logical event collapses in the queue; the dispatcher's
 * processed_events claim is the second, durable dedup layer.
 */
export async function enqueueWorkflowEvent(boss: PgBoss, event: WorkflowEvent): Promise<void> {
  await boss.send(WORKFLOW_DISPATCH_QUEUE, event, {
    singletonKey: `wf:${event.locationId}:${event.eventId}`,
  })
}

/** Diagnostic owner recorded on wait claims (which worker holds it). */
function workerIdentity(): string {
  return process.env.FLY_MACHINE_ID ?? 'local'
}

/** A claimed-but-never-completed wait becomes reclaimable after this long. */
export const STALE_WAIT_CLAIM_MS = 30 * 60_000

export interface ResumeJobData {
  waitId: string
  locationId: string
}

/**
 * The production ScheduleWait (FIND-06): persist the continuation, then arm
 * a delayed resume job for its due date. Persist-first ordering means a crash
 * between the two leaves a recoverable pending row (boot reaper), never a
 * job pointing at nothing. The singleton key collapses duplicate schedules
 * of the same wait row.
 */
export function createDurableWaitScheduler(
  boss: Pick<PgBoss, 'sendAfter'>,
  db: Database,
): ScheduleWait {
  return async (continuation) => {
    const row = await new WorkflowWaitsRepo(db, continuation.locationId).persist(continuation)
    await boss.sendAfter(
      WORKFLOW_RESUME_QUEUE,
      { waitId: row.id, locationId: continuation.locationId },
      { singletonKey: `wait:${row.id}` },
      continuation.dueAt,
    )
  }
}

export type ResumeOutcome = 'resumed' | 'skipped' | 'failed-run'

export interface ResumeDeps {
  db: Database
  runnerDeps: WorkflowRunnerDeps
}

/**
 * Resume one parked run (FIND-06, G4). Claim → verify run still waiting →
 * verify the live definition still hashes to the pinned one → complete the
 * wait row → run. Anything unexpected fails the RUN closed (failed step +
 * failed status) instead of executing against changed logic, and duplicate
 * deliveries collapse at the claim.
 */
export async function handleWorkflowResume(deps: ResumeDeps, job: ResumeJobData): Promise<ResumeOutcome> {
  const { db } = deps
  const waits = new WorkflowWaitsRepo(db, job.locationId)
  const claimed = await waits.claimOne(job.waitId, workerIdentity(), STALE_WAIT_CLAIM_MS)
  if (!claimed) return 'skipped'

  const runsRepo = new WorkflowRunsRepo(db, job.locationId)
  const failRun = async (detail: string): Promise<ResumeOutcome> => {
    await runsRepo.appendStep(
      claimed.run_id,
      { position: claimed.from_position, type: 'wait', status: 'failed', detail },
      'failed',
    )
    await runsRepo.finish(claimed.run_id, 'failed')
    await waits.markFailed(claimed.id)
    return 'failed-run'
  }

  if (claimed.attempts > MAX_RESUME_ATTEMPTS) {
    return failRun(`Resume abandoned after ${claimed.attempts} attempts`)
  }
  const run = await runsRepo.get(claimed.run_id)
  if (!run || run.status !== 'waiting') {
    await waits.markCancelled(claimed.id)
    return 'skipped'
  }
  const workflow = await new WorkflowsRepo(db, job.locationId).get(claimed.workflow_id)
  if (!workflow) return failRun('Workflow was deleted during the wait')
  const actions = await new WorkflowActionsRepo(db, job.locationId).listByWorkflow(claimed.workflow_id)
  if (definitionHash(actions) !== claimed.definition_hash) {
    return failRun('Workflow definition changed during the wait — refusing to resume stale steps')
  }

  // Complete the wait BEFORE running: a chained wait later in this resume
  // must be able to persist without tripping the single-live-row guard, and
  // a duplicate delivery arriving mid-run finds nothing to claim.
  await waits.markCompleted(claimed.id)
  await runWorkflow(
    deps.runnerDeps,
    {
      locationId: claimed.location_id,
      workflowId: claimed.workflow_id,
      contactId: claimed.contact_id,
      triggerType: claimed.trigger_type,
    },
    { runId: claimed.run_id, fromPosition: claimed.from_position },
  )
  return 'resumed'
}

export async function registerWorkflowResumeWorker(
  boss: PgBoss,
  deps: { db: Database; waitsEnabled: boolean },
): Promise<void> {
  const runnerDeps: WorkflowRunnerDeps = {
    db: deps.db,
    scheduleWait: createDurableWaitScheduler(boss, deps.db),
    waitsEnabled: deps.waitsEnabled,
  }
  await boss.work<ResumeJobData>(WORKFLOW_RESUME_QUEUE, SINGLE_JOB, async (jobs) => {
    for (const job of jobs) {
      await handleWorkflowResume({ db: deps.db, runnerDeps }, job.data)
    }
  })
}

/**
 * Boot reaper (FIND-06, G4): re-enqueue resume jobs for waits whose delayed
 * job evidently never arrived (overdue pending rows) or whose worker died
 * mid-resume (stale claims). Every re-enqueued job still passes through the
 * atomic claim, so reaper-vs-live-job overlap converges instead of doubling.
 * Returns the number of jobs enqueued.
 */
export async function reapStaleWaits(
  db: Database,
  boss: Pick<PgBoss, 'send'>,
  opts: { graceMs?: number; staleClaimMs?: number; limit?: number } = {},
): Promise<number> {
  const rows = await WorkflowWaitsRepo.overdueIds(db, opts.graceMs ?? 5 * 60_000, opts.staleClaimMs ?? STALE_WAIT_CLAIM_MS, opts.limit ?? 100)
  for (const row of rows) {
    await boss.send(
      WORKFLOW_RESUME_QUEUE,
      { waitId: row.id, locationId: row.location_id },
      { singletonKey: `wait:${row.id}` },
    )
  }
  return rows.length
}
