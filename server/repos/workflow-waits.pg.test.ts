/**
 * Wait-claim race on real PostgreSQL (FIND-06, G4): two workers claiming the
 * same due wait must produce exactly one owner. Runs via `task test:pg`.
 */
import { readFileSync } from 'node:fs'
import { inject } from 'vitest'
import { Pool } from 'pg'
import { PgDatabase } from '../db/database'
import { WorkflowWaitsRepo } from './workflow-waits-repo'

const baseUrl: string = inject('pgTestUrl') ?? process.env.OPENLEVEL_PG_TEST_URL ?? ''
if (baseUrl === '') throw new Error('pgTestUrl not provided — run via task test:pg')

const SCHEMA = readFileSync(new URL('../../db/schema.sql', import.meta.url), 'utf8')

beforeAll(async () => {
  const pool = new Pool({ connectionString: baseUrl })
  try {
    await pool.query(SCHEMA)
  } finally {
    await pool.end()
  }
})

test('concurrent claims on one due wait elect exactly one owner', async () => {
  const pool = new Pool({ connectionString: baseUrl, max: 4 })
  try {
    const loc = `wt_${process.pid}_${Math.floor(Math.random() * 1e9)}`
    await pool.query(`INSERT INTO locations (id, name, slug) VALUES ($1, 'T', $1)`, [loc])
    const wf = await pool.query<{ id: string }>(
      `INSERT INTO workflows (id, location_id, name, trigger_type, status) VALUES ('w1-${loc}', $1, 'W', 'contact_created', 'live') RETURNING id`,
      [loc],
    )
    const run = await pool.query<{ id: string }>(
      `INSERT INTO workflow_runs (id, location_id, workflow_id, trigger_type, status) VALUES ('r1-${loc}', $1, $2, 'contact_created', 'waiting') RETURNING id`,
      [loc, wf.rows[0]?.id],
    )
    const db = new PgDatabase(pool)
    const row = await new WorkflowWaitsRepo(db, loc).persist({
      locationId: loc,
      runId: run.rows[0]?.id ?? '',
      workflowId: wf.rows[0]?.id ?? '',
      contactId: null,
      triggerType: 'contact_created',
      fromPosition: 1,
      dueAt: new Date(Date.now() - 1000),
      definitionHash: 'h',
    })
    const repo = new WorkflowWaitsRepo(db, loc)
    const [a, b] = await Promise.all([
      repo.claimOne(row.id, 'worker-a', 30 * 60_000),
      repo.claimOne(row.id, 'worker-b', 30 * 60_000),
    ])
    const winners = [a, b].filter((r) => r !== undefined)
    expect(winners).toHaveLength(1)
  } finally {
    await pool.end()
  }
})
