import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { FakeDatabase } from '../db/fake-database'
import { PgliteDatabase } from '../db/pglite-database'
import { WorkflowActionsRepo } from '../repos/workflow-actions-repo'
import { WorkflowRunsRepo } from '../repos/workflow-runs-repo'
import { WorkflowWaitsRepo } from '../repos/workflow-waits-repo'
import { type WorkflowActionInput, WorkflowsRepo } from '../repos/workflows-repo'
import {
  WORKFLOW_RESUME_QUEUE,
  createDurableWaitScheduler,
  handleWorkflowResume,
  reapStaleWaits,
} from './boss'
import { type WaitContinuation, definitionHash, runWorkflow } from './workflow-runner'

const SCHEMA = readFileSync(fileURLToPath(new URL('../../db/schema.sql', import.meta.url)), 'utf8')
const NOW = 1_700_000_000_000

async function harness(steps: WorkflowActionInput[]) {
  const pg = new PGlite()
  await pg.exec(SCHEMA)
  const db = new PgliteDatabase(pg)
  const loc = 'loc_test'
  await db.query("INSERT INTO locations (id, name, slug) VALUES ($1,'Test','test')", [loc])
  await db.query(
    "INSERT INTO contacts (id, location_id, name, first_name, last_name) VALUES ('c1',$1,'Derek Sull','Derek','Sull')",
    [loc],
  )
  const wf = await new WorkflowsRepo(db, loc).create({ name: 'Test wf', triggerType: 'contact_created' })
  await new WorkflowActionsRepo(db, loc).replaceAll(wf.id, steps)
  return { db, loc, workflowId: wf.id }
}

const TAG = { type: 'add_tag', config: { tag: 'welcomed' } } as WorkflowActionInput
const WAIT = { type: 'wait', config: { minutes: 30 } } as WorkflowActionInput

test('a wait with scheduleWait persists a full continuation and never arms timers (FIND-06)', async () => {
  const { db, loc, workflowId } = await harness([TAG, WAIT, TAG])
  const continuations: WaitContinuation[] = []
  let timers = 0
  const run = await runWorkflow(
    {
      db,
      waitsEnabled: true,
      now: () => NOW,
      schedule: () => {
        timers += 1
      },
      scheduleWait: async (c) => {
        continuations.push(c)
      },
    },
    { locationId: loc, workflowId, contactId: 'c1', triggerType: 'contact_created' },
  )
  expect(run.status).toBe('waiting')
  expect(timers).toBe(0) // exactly one resume path owns the wait
  expect(continuations).toHaveLength(1)
  const c = continuations[0]!
  expect(c).toMatchObject({ locationId: loc, runId: run.id, workflowId, contactId: 'c1', fromPosition: 2 })
  expect(c.dueAt.getTime()).toBe(NOW + 30 * 60_000)
  expect(typeof c.definitionHash).toBe('string')
  expect(c.definitionHash).toHaveLength(64)
})

test('definitionHash is stable for identical actions and moves on any edit (G4)', () => {
  const base = [
    { id: 'a', location_id: 'l', workflow_id: 'w', position: 0, type: 'wait', config: { minutes: 30 }, created_at: '' },
    { id: 'b', location_id: 'l', workflow_id: 'w', position: 1, type: 'add_tag', config: { tag: 'x' }, created_at: '' },
  ]
  const same = definitionHash([...base].reverse())
  expect(same).toBe(definitionHash(base)) // order-independent input
  expect(definitionHash([{ ...base[0]!, config: { minutes: 31 } }, base[1]!])).not.toBe(same) // config edit
  expect(definitionHash([base[0]!])).not.toBe(same) // removed step
})

test('resume executes the remaining steps and completes the wait (FIND-06)', async () => {
  const { db, loc, workflowId } = await harness([TAG, WAIT, TAG])
  const continuations: WaitContinuation[] = []
  const paused = await runWorkflow(
    { db, waitsEnabled: true, now: () => NOW, scheduleWait: async (c) => void continuations.push(c) },
    { locationId: loc, workflowId, contactId: 'c1', triggerType: 'contact_created' },
  )
  // Persist what the scheduler would have, then resume through the handler.
  const row = await new WorkflowWaitsRepo(db, loc).persist(continuations[0]!)
  const outcome = await handleWorkflowResume({ db, runnerDeps: { db, waitsEnabled: true } }, { waitId: row.id, locationId: loc })
  expect(outcome).toBe('resumed')
  const finished = await new WorkflowRunsRepo(db, loc).get(paused.id)
  expect(finished?.status).toBe('completed')
  expect(finished?.steps).toHaveLength(3)
  const [contact] = await db.query<{ tags: string[] }>('SELECT tags FROM contacts WHERE id=$1', ['c1'])
  expect(contact?.tags).toContain('welcomed')
  const [wait] = await db.query<{ status: string }>('SELECT status FROM workflow_waits WHERE id=$1', [row.id])
  expect(wait?.status).toBe('completed')
})

test('duplicate resume deliveries collapse: one runs, the rest skip (FIND-06)', async () => {
  const { db, loc, workflowId } = await harness([WAIT, TAG])
  const continuations: WaitContinuation[] = []
  await runWorkflow(
    { db, waitsEnabled: true, now: () => NOW, scheduleWait: async (c) => void continuations.push(c) },
    { locationId: loc, workflowId, contactId: 'c1', triggerType: 'contact_created' },
  )
  const row = await new WorkflowWaitsRepo(db, loc).persist(continuations[0]!)
  const deps = { db, runnerDeps: { db, waitsEnabled: true } }
  const job = { waitId: row.id, locationId: loc }
  expect(await handleWorkflowResume(deps, job)).toBe('resumed')
  expect(await handleWorkflowResume(deps, job)).toBe('skipped')
  expect(await handleWorkflowResume(deps, job)).toBe('skipped')
  const runs = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM workflow_runs')
  expect(runs[0]?.n).toBe(1)
})

test('resume against an edited definition fails closed without executing (G4)', async () => {
  const { db, loc, workflowId } = await harness([WAIT, TAG])
  const continuations: WaitContinuation[] = []
  const paused = await runWorkflow(
    { db, waitsEnabled: true, now: () => NOW, scheduleWait: async (c) => void continuations.push(c) },
    { locationId: loc, workflowId, contactId: 'c1', triggerType: 'contact_created' },
  )
  const row = await new WorkflowWaitsRepo(db, loc).persist(continuations[0]!)
  // Operator edits the workflow mid-wait: the pinned hash no longer matches.
  await new WorkflowActionsRepo(db, loc).replaceAll(workflowId, [WAIT, { type: 'add_tag', config: { tag: 'changed' } }])
  const outcome = await handleWorkflowResume({ db, runnerDeps: { db, waitsEnabled: true } }, { waitId: row.id, locationId: loc })
  expect(outcome).toBe('failed-run')
  const finished = await new WorkflowRunsRepo(db, loc).get(paused.id)
  expect(finished?.status).toBe('failed')
  expect(JSON.stringify(finished?.steps)).toMatch(/definition changed/)
  const [contact] = await db.query<{ tags: string[] }>('SELECT tags FROM contacts WHERE id=$1', ['c1'])
  expect(contact?.tags ?? []).not.toContain('welcomed')
  expect(contact?.tags ?? []).not.toContain('changed')
})

test('resume of a deleted workflow cancels cleanly: cascade took the run (G4)', async () => {
  const { db, loc, workflowId } = await harness([WAIT, TAG])
  const continuations: WaitContinuation[] = []
  await runWorkflow(
    { db, waitsEnabled: true, now: () => NOW, scheduleWait: async (c) => void continuations.push(c) },
    { locationId: loc, workflowId, contactId: 'c1', triggerType: 'contact_created' },
  )
  const row = await new WorkflowWaitsRepo(db, loc).persist(continuations[0]!)
  // Deleting the workflow cascades to its runs AND this wait row (FKs), so a
  // redelivered resume finds nothing to claim and skips — no execution, no
  // strand. (The defensive !workflow branch below covers FK-less stores.)
  await db.query('DELETE FROM workflows WHERE id = $1', [workflowId])
  const outcome = await handleWorkflowResume({ db, runnerDeps: { db, waitsEnabled: true } }, { waitId: row.id, locationId: loc })
  expect(outcome).toBe('skipped')
  const leftovers = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM workflow_waits')
  expect(leftovers[0]?.n).toBe(0)
})

test('resume with a waiting run but missing workflow fails the run closed (G4)', async () => {
  // Defensive branch: unreachable under the FK cascade (proven above), but a
  // store without enforcement must still refuse to execute, never run blind.
  const db = new FakeDatabase()
  const claimed = {
    id: 'w1',
    location_id: 'locA',
    run_id: 'r1',
    workflow_id: 'wf-gone',
    contact_id: 'c1',
    trigger_type: 'contact_created',
    from_position: 1,
    attempts: 1,
  }
  db.enqueue([claimed]) // claimOne won
  db.enqueue([{ id: 'r1', status: 'waiting' }]) // run still waiting
  db.enqueue([]) // workflow get -> missing
  db.enqueue([{ id: 'r1' }]) // appendStep failed
  db.enqueue([{ id: 'r1' }]) // finish failed
  db.enqueue([]) // markFailed
  const outcome = await handleWorkflowResume({ db, runnerDeps: { db, waitsEnabled: true } }, { waitId: 'w1', locationId: 'locA' })
  expect(outcome).toBe('failed-run')
  const failedStep = db.calls.find(
    (c) => /UPDATE workflow_runs SET steps/i.test(c.sql) && JSON.stringify(c.params).includes('deleted during the wait'),
  )
  expect(failedStep).toBeDefined()
})

test('resume of a no-longer-waiting run cancels the wait and skips (G4)', async () => {
  const { db, loc, workflowId } = await harness([WAIT, TAG])
  const continuations: WaitContinuation[] = []
  const paused = await runWorkflow(
    { db, waitsEnabled: true, now: () => NOW, scheduleWait: async (c) => void continuations.push(c) },
    { locationId: loc, workflowId, contactId: 'c1', triggerType: 'contact_created' },
  )
  const row = await new WorkflowWaitsRepo(db, loc).persist(continuations[0]!)
  await new WorkflowRunsRepo(db, loc).finish(paused.id, 'completed')
  const outcome = await handleWorkflowResume({ db, runnerDeps: { db, waitsEnabled: true } }, { waitId: row.id, locationId: loc })
  expect(outcome).toBe('skipped')
  const [wait] = await db.query<{ status: string }>('SELECT status FROM workflow_waits WHERE id=$1', [row.id])
  expect(wait?.status).toBe('cancelled')
})

test('exhausted resume attempts fail the run instead of retrying forever (G4)', async () => {
  const { db, loc, workflowId } = await harness([WAIT, TAG])
  const continuations: WaitContinuation[] = []
  const paused = await runWorkflow(
    { db, waitsEnabled: true, now: () => NOW, scheduleWait: async (c) => void continuations.push(c) },
    { locationId: loc, workflowId, contactId: 'c1', triggerType: 'contact_created' },
  )
  const row = await new WorkflowWaitsRepo(db, loc).persist(continuations[0]!)
  await db.query('UPDATE workflow_waits SET attempts = 99 WHERE id = $1', [row.id])
  const outcome = await handleWorkflowResume({ db, runnerDeps: { db, waitsEnabled: true } }, { waitId: row.id, locationId: loc })
  expect(outcome).toBe('failed-run')
  const finished = await new WorkflowRunsRepo(db, loc).get(paused.id)
  expect(finished?.status).toBe('failed')
})

test('createDurableWaitScheduler persists first, then arms a singleton delayed job', async () => {
  const { db, loc, workflowId } = await harness([WAIT])
  const calls: { name: string; data: unknown; options: unknown; date: unknown }[] = []
  const fakeBoss = {
    sendAfter: async (name: string, data: unknown, options: unknown, date: unknown) => {
      calls.push({ name, data, options, date })
      return 'job-1'
    },
  }
  // Park a real run so the continuation references a live run row.
  let continuation!: Parameters<ReturnType<typeof createDurableWaitScheduler>>[0]
  const paused = await runWorkflow(
    { db, waitsEnabled: true, now: () => NOW, scheduleWait: async (c) => void (continuation = c) },
    { locationId: loc, workflowId, contactId: 'c1', triggerType: 'contact_created' },
  )
  expect(paused.status).toBe('waiting')
  await createDurableWaitScheduler(fakeBoss as never, db)(continuation)
  const [row] = await db.query<{ id: string; status: string; run_id: string }>(
    'SELECT id, status, run_id FROM workflow_waits',
  )
  expect(row).toMatchObject({ status: 'pending', run_id: paused.id })
  expect(calls).toHaveLength(1)
  expect(calls[0]?.name).toBe(WORKFLOW_RESUME_QUEUE)
  expect(calls[0]?.data).toMatchObject({ waitId: row?.id, locationId: loc })
  expect(calls[0]?.options).toMatchObject({ singletonKey: `wait:${row?.id}` })
  expect((calls[0]?.date as Date).getTime()).toBe(continuation.dueAt.getTime())
})

test('scheduler persist failure arms no job (persist-first ordering)', async () => {
  const { db, loc, workflowId } = await harness([WAIT])
  let calls = 0
  const fakeBoss = {
    sendAfter: async () => {
      calls += 1
      return 'job-1'
    },
  }
  // run-1 does not exist: the FK rejects the persist, so no job may be armed.
  await expect(
    createDurableWaitScheduler(fakeBoss as never, db)({
      locationId: loc,
      runId: 'run-1',
      workflowId,
      contactId: 'c1',
      triggerType: 'contact_created',
      fromPosition: 1,
      dueAt: new Date(NOW + 5000),
      definitionHash: 'abc',
    }),
  ).rejects.toThrow()
  expect(calls).toBe(0)
})

test('reaper re-enqueues overdue waits and ignores fresh ones (G4)', async () => {
  const { db, loc, workflowId } = await harness([WAIT])
  const repo = new WorkflowWaitsRepo(db, loc)
  // A parked run with an overdue pending wait (lost delayed job).
  const paused = await runWorkflow(
    { db, waitsEnabled: true, now: () => 0, scheduleWait: async () => {} },
    { locationId: loc, workflowId, contactId: 'c1', triggerType: 'contact_created' },
  )
  const overdue = await repo.persist({
    locationId: loc,
    runId: paused.id,
    workflowId,
    contactId: 'c1',
    triggerType: 'contact_created',
    fromPosition: 1,
    dueAt: new Date(Date.now() - 60 * 60_000),
    definitionHash: 'x',
  })
  const sends: { name: string; data: unknown; options: unknown }[] = []
  const fakeBoss = {
    send: async (name: string, data: unknown, options: unknown) => {
      sends.push({ name, data, options })
      return 'job-1'
    },
  }
  const reaped = await reapStaleWaits(db, fakeBoss as never, { graceMs: 1000, staleClaimMs: 1000 })
  expect(reaped).toBe(1)
  expect(sends).toHaveLength(1)
  expect(sends[0]?.name).toBe(WORKFLOW_RESUME_QUEUE)
  expect(sends[0]?.data).toMatchObject({ waitId: overdue.id, locationId: loc })
  expect(sends[0]?.options).toMatchObject({ singletonKey: `wait:${overdue.id}` })
})
