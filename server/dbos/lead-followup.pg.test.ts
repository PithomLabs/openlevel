/**
 * DBOS lead-follow-up pilot acceptance (ADR-002, §19). Runs against real
 * disposable PostgreSQL 18.7 via `task test:pg` — DBOS needs a true PG
 * system database (LISTEN/NOTIFY, advisory semantics PGlite cannot provide).
 *
 * Proves: stable identity + duplicate-start collapse, transactional handoff,
 * genuine durable sleep, worker replacement recovery, eligibility re-check,
 * exactly-once synthetic effect, terminal states, cancellation, explicit
 * version behavior, and observable execution history.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { DBOS } from '@dbos-inc/dbos-sdk'
import { inject } from 'vitest'
import { Pool } from 'pg'
import { PgDatabase } from '../db/database'
import { drainOutbox } from '../jobs/outbox-relay'
import { leadFollowUpWorkflowId } from './lead-followup'
import {
  launchPilotDbos,
  migratePilotSchema,
  requestLeadFollowUp,
  shutdownPilotDbos,
  startLeadFollowUp,
} from './pilot'

const baseUrl: string = inject('pgTestUrl') ?? process.env.OPENLEVEL_PG_TEST_URL ?? ''
if (baseUrl === '') throw new Error('pgTestUrl not provided — run via task test:pg')

const SCHEMA = readFileSync(new URL('../../db/schema.sql', import.meta.url), 'utf8')
const APP_VERSION = 'pilot-v1'

beforeAll(async () => {
  const pool = new Pool({ connectionString: baseUrl })
  try {
    await pool.query(SCHEMA)
  } finally {
    await pool.end()
  }
  await migratePilotSchema(baseUrl)
}, 120000)

let tag = 0
async function setup() {
  tag += 1
  const pool = new Pool({ connectionString: baseUrl, max: 4 })
  const db = new PgDatabase(pool)
  const loc = `dbos_${process.pid}_${tag}_${Math.floor(Math.random() * 1e9)}`
  await db.query(`INSERT INTO locations (id, name, slug) VALUES ($1, 'T', $1)`, [loc])
  const contactId = `c_${tag}`
  await db.query(
    `INSERT INTO contacts (id, location_id, name, emails, phones) VALUES ($1, $2, 'Lead Person', $3, $4)`,
    [contactId, loc, ['lead@example.com'], ['+16025550100']],
  )
  return { pool, db, loc, contactId, op: `op_${tag}_${Date.now()}` }
}

/** getResult with a bounded wait: a hung workflow fails the test, never the suite. */
async function resultOf<T>(handle: { getResult: () => Promise<T> }, ms = 30000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      handle.getResult(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timed out waiting for workflow result')), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function launched(ctx: Awaited<ReturnType<typeof setup>>, over: { executorId?: string; version?: string } = {}) {
  await launchPilotDbos({
    systemDatabaseUrl: baseUrl,
    executorId: over.executorId ?? `exec_${ctx.op}`,
    applicationVersion: over.version ?? APP_VERSION,
    db: ctx.db,
  })
}

test('full lifecycle: request → outbox handoff → sleep → recheck → synthetic follow-up → terminal state', async () => {
  const ctx = await setup()
  try {
    await launched(ctx)
    try {
      await requestLeadFollowUp(ctx.db, ctx.loc, { contactId: ctx.contactId, operationId: ctx.op, delayMs: 1500 })
      const drained = await drainOutbox(ctx.db, ctx.loc, async () => {}, {
        startDbosWorkflow: (locationId, intent) =>
          startLeadFollowUp({ locationId, contactId: intent.contactId, operationId: intent.operationId, delayMs: intent.delayMs }),
      })
      expect(drained).toEqual({ sent: 1, failed: 0 })
      const handle = DBOS.retrieveWorkflow(leadFollowUpWorkflowId({ locationId: ctx.loc, operationId: ctx.op }))
      const outcome = await resultOf(handle)
      expect(outcome).toMatchObject({ terminal: 'followed-up' })
      // Observable history: recorded status + exactly one effect row.
      const status = await DBOS.getWorkflowStatus(leadFollowUpWorkflowId({ locationId: ctx.loc, operationId: ctx.op }))
      expect(status?.status).toBe('SUCCESS')
      expect(status?.workflowName).toMatch(/leadFollowUp/i)
      const rows = await ctx.db.query<{ id: string }>(
        'SELECT id FROM timeline_events WHERE location_id = $1 AND type = $2',
        [ctx.loc, 'followup_completed'],
      )
      expect(rows).toHaveLength(1)
      expect(rows[0]?.id).toBe(`followup:${ctx.loc}:${ctx.op}`)
    } finally {
      await shutdownPilotDbos()
    }
  } finally {
    await ctx.pool.end()
  }
}, 60000)

test('stable identity: duplicate starts collapse onto one execution, one effect', async () => {
  const ctx = await setup()
  try {
    await launched(ctx)
    try {
      const input = { locationId: ctx.loc, contactId: ctx.contactId, operationId: ctx.op, delayMs: 500 }
      const [a, b] = await Promise.all([startLeadFollowUp(input), startLeadFollowUp(input)])
      expect(a.workflowID).toBe(b.workflowID)
      expect(await resultOf(a)).toMatchObject({ terminal: 'followed-up' })
      expect(await resultOf(b)).toMatchObject({ terminal: 'followed-up' })
      const rows = await ctx.db.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM timeline_events WHERE location_id = $1 AND type = $2',
        [ctx.loc, 'followup_completed'],
      )
      expect(rows[0]?.n).toBe(1)
    } finally {
      await shutdownPilotDbos()
    }
  } finally {
    await ctx.pool.end()
  }
}, 60000)

test('handoff is transactional: missing contact refuses with no intent row', async () => {
  const ctx = await setup()
  try {
    await expect(
      requestLeadFollowUp(ctx.db, ctx.loc, { contactId: 'nope', operationId: ctx.op, delayMs: 500 }),
    ).rejects.toThrow(/no contact nope/)
    const rows = await ctx.db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM outbox WHERE location_id = $1 AND aggregate = 'dbos_workflow'",
      [ctx.loc],
    )
    expect(rows[0]?.n).toBe(0)
  } finally {
    await ctx.pool.end()
  }
})

test('worker replacement: shutdown mid-sleep, relaunch recovers and finishes exactly once', async () => {
  const ctx = await setup()
  const executorId = `exec_relaunch_${ctx.op}`
  try {
    await launchPilotDbos({ systemDatabaseUrl: baseUrl, executorId, applicationVersion: APP_VERSION, db: ctx.db })
    const input = { locationId: ctx.loc, contactId: ctx.contactId, operationId: ctx.op, delayMs: 6000 }
    await startLeadFollowUp(input)
    await new Promise((r) => setTimeout(r, 1500)) // let it enter the durable sleep
    await shutdownPilotDbos() // no drain: the closest in-process equivalent of a crash
    await launchPilotDbos({ systemDatabaseUrl: baseUrl, executorId, applicationVersion: APP_VERSION, db: ctx.db })
    try {
      const handle = DBOS.retrieveWorkflow(leadFollowUpWorkflowId({ locationId: ctx.loc, operationId: ctx.op }))
      expect(await resultOf(handle, 45000)).toMatchObject({ terminal: 'followed-up' })
      const rows = await ctx.db.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM timeline_events WHERE location_id = $1 AND type = $2',
        [ctx.loc, 'followup_completed'],
      )
      expect(rows[0]?.n).toBe(1)
    } finally {
      await shutdownPilotDbos()
    }
  } finally {
    await ctx.pool.end()
  }
}, 90000)

test('ineligible and missing leads terminate fast without sleeping or effects', async () => {
  const ctx = await setup()
  try {
    await launched(ctx)
    try {
      await ctx.db.query('UPDATE contacts SET archived_at = now() WHERE id = $1', [ctx.contactId])
      const archived = await startLeadFollowUp({
        locationId: ctx.loc,
        contactId: ctx.contactId,
        operationId: `${ctx.op}-a`,
        delayMs: 60000,
      })
      expect(await resultOf(archived, 15000)).toMatchObject({ terminal: 'ineligible' })
      const missing = await startLeadFollowUp({
        locationId: ctx.loc,
        contactId: 'ghost',
        operationId: `${ctx.op}-m`,
        delayMs: 60000,
      })
      expect(await resultOf(missing, 15000)).toMatchObject({ terminal: 'no-lead' })
      const rows = await ctx.db.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM timeline_events WHERE location_id = $1 AND type = $2',
        [ctx.loc, 'followup_completed'],
      )
      expect(rows[0]?.n).toBe(0)
    } finally {
      await shutdownPilotDbos()
    }
  } finally {
    await ctx.pool.end()
  }
}, 60000)

test('lapsed: archived mid-sleep terminates without the follow-up effect', async () => {
  const ctx = await setup()
  try {
    await launched(ctx)
    try {
      const handle = await startLeadFollowUp({
        locationId: ctx.loc,
        contactId: ctx.contactId,
        operationId: ctx.op,
        delayMs: 2500,
      })
      await new Promise((r) => setTimeout(r, 800))
      await ctx.db.query('UPDATE contacts SET archived_at = now() WHERE id = $1', [ctx.contactId])
      expect(await resultOf(handle)).toMatchObject({ terminal: 'lapsed' })
      const rows = await ctx.db.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM timeline_events WHERE location_id = $1 AND type = $2',
        [ctx.loc, 'followup_completed'],
      )
      expect(rows[0]?.n).toBe(0)
    } finally {
      await shutdownPilotDbos()
    }
  } finally {
    await ctx.pool.end()
  }
}, 60000)

test('cancellation stops a sleeping workflow with no follow-up effect', async () => {
  const ctx = await setup()
  try {
    await launched(ctx)
    try {
      const id = leadFollowUpWorkflowId({ locationId: ctx.loc, operationId: ctx.op })
      await startLeadFollowUp({ locationId: ctx.loc, contactId: ctx.contactId, operationId: ctx.op, delayMs: 60000 })
      await new Promise((r) => setTimeout(r, 800))
      await DBOS.cancelWorkflow(id)
      let status = await DBOS.getWorkflowStatus(id)
      for (let i = 0; i < 10 && status?.status !== 'CANCELLED'; i++) {
        await new Promise((r) => setTimeout(r, 500))
        status = await DBOS.getWorkflowStatus(id)
      }
      expect(status?.status).toBe('CANCELLED')
      const rows = await ctx.db.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM timeline_events WHERE location_id = $1 AND type = $2',
        [ctx.loc, 'followup_completed'],
      )
      expect(rows[0]?.n).toBe(0)
    } finally {
      await shutdownPilotDbos()
    }
  } finally {
    await ctx.pool.end()
  }
}, 60000)

test('SIGKILL mid-sleep: a replacement executor recovers and finishes exactly once', async () => {
  const ctx = await setup()
  const executorId = `exec_kill_${ctx.op}`
  let child: ChildProcess | null = null
  try {
    child = spawn(
      process.execPath,
      ['--import', 'tsx', 'server/dbos/pilot-child.ts'],
      {
        env: {
          ...process.env,
          PILOT_PG_URL: baseUrl,
          PILOT_LOCATION: ctx.loc,
          PILOT_CONTACT: ctx.contactId,
          PILOT_OPERATION: ctx.op,
          PILOT_DELAY_MS: '12000',
          PILOT_EXECUTOR: executorId,
          PILOT_VERSION: APP_VERSION,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    const stderr: string[] = []
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk.toString()))
    // Wait for READY (workflow started and sleeping), then let it settle.
    const ready = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`child never became ready: ${stderr.join('').slice(0, 500)}`)), 45000)
      let out = ''
      child?.stdout?.on('data', (chunk: Buffer) => {
        out += chunk.toString()
        const match = /READY (\S+)/.exec(out)
        if (match?.[1]) {
          clearTimeout(timer)
          resolve(match[1])
        }
      })
      child?.on('exit', (code) => {
        clearTimeout(timer)
        reject(new Error(`child exited before READY (code ${code}): ${stderr.join('').slice(0, 500)}`))
      })
    })
    expect(ready).toBe(leadFollowUpWorkflowId({ locationId: ctx.loc, operationId: ctx.op }))
    await new Promise((r) => setTimeout(r, 2000))
    child.kill('SIGKILL')
    await new Promise<void>((resolve) => {
      if (child?.exitCode !== null || child?.signalCode !== null) return resolve()
      child?.on('exit', () => resolve())
    })
    child = null
    // Replacement executor, same identity: launch-time self-recovery resumes it.
    await launchPilotDbos({ systemDatabaseUrl: baseUrl, executorId, applicationVersion: APP_VERSION, db: ctx.db })
    try {
      const handle = DBOS.retrieveWorkflow(ready)
      expect(await resultOf(handle, 60000)).toMatchObject({ terminal: 'followed-up' })
      const rows = await ctx.db.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM timeline_events WHERE location_id = $1 AND type = $2',
        [ctx.loc, 'followup_completed'],
      )
      expect(rows[0]?.n).toBe(1)
    } finally {
      await shutdownPilotDbos()
    }
  } finally {
    child?.kill('SIGKILL')
    await ctx.pool.end()
  }
}, 120000)

test('version mismatch never silently resumes under the wrong definition', async () => {
  const ctx = await setup()
  const executorId = `exec_version_${ctx.op}`
  try {
    await launchPilotDbos({ systemDatabaseUrl: baseUrl, executorId, applicationVersion: 'pilot-v1', db: ctx.db })
    await startLeadFollowUp({ locationId: ctx.loc, contactId: ctx.contactId, operationId: ctx.op, delayMs: 2500 })
    await new Promise((r) => setTimeout(r, 800))
    await shutdownPilotDbos()
    // Relaunch the same executor on a DIFFERENT application version: the v1
    // workflow must not complete under v2 semantics. The observation window
    // (6s) extends past the original 2.5s wake time, so a wrongful resume
    // WOULD complete inside it and fail this test.
    await launchPilotDbos({ systemDatabaseUrl: baseUrl, executorId, applicationVersion: 'pilot-v2', db: ctx.db })
    try {
      await new Promise((r) => setTimeout(r, 6000))
      const status = await DBOS.getWorkflowStatus(leadFollowUpWorkflowId({ locationId: ctx.loc, operationId: ctx.op }))
      expect(['PENDING', 'ERROR']).toContain(status?.status)
      const rows = await ctx.db.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM timeline_events WHERE location_id = $1 AND type = $2',
        [ctx.loc, 'followup_completed'],
      )
      expect(rows[0]?.n).toBe(0)
    } finally {
      await shutdownPilotDbos()
    }
  } finally {
    await ctx.pool.end()
  }
}, 90000)
