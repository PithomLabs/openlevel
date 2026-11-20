/**
 * R13-10 concurrency on real PostgreSQL: twins confirming one proposal key
 * must collapse to a single execution. PGlite serializes, so only real
 * Postgres proves the claim race. Runs via `task test:pg`.
 */
import { readFileSync } from 'node:fs'
import { inject } from 'vitest'
import { Pool } from 'pg'
import { PgDatabase } from '../db/database'
import { confirmOperatorWrite } from './operator-tools'

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

test('R13-10 on real PG: concurrent same-key confirms execute exactly once; losers replay', async () => {
  const pool = new Pool({ connectionString: baseUrl, max: 8 })
  try {
    const db = new PgDatabase(pool)
    const loc = `cf_${process.pid}_${Math.floor(Math.random() * 1e9)}`
    await db.query(`INSERT INTO locations (id, name, slug) VALUES ($1, 'T', $1)`, [loc])
    await db.query(`INSERT INTO contacts (id, location_id, name) VALUES ('cc1', $1, 'Cee')`, [loc])
    const attempt = () =>
      confirmOperatorWrite({ db, locationId: loc }, { verb: 'create_task', params: { contactId: 'cc1', title: 'Race' } }, {
        idempotencyKey: 'k-race-1',
      }).then(
        (r) => ({ status: 'ok' as const, message: r.message }),
        (err: unknown) => ({ status: 'error' as const, name: (err as Error).name }),
      )
    const results = await Promise.all([attempt(), attempt(), attempt(), attempt(), attempt(), attempt()])
    const ok = results.filter((r) => r.status === 'ok')
    // Every twin either executed-or-replayed (same message) or hit the
    // in-progress guard; nothing else may surface.
    expect(ok.length).toBeGreaterThanOrEqual(1)
    expect(new Set(ok.map((r) => (r as { message: string }).message)).size).toBe(1)
    for (const r of results) {
      if (r.status === 'error') expect((r as { name: string }).name).toBe('IdempotencyInProgress')
    }
    // Retry the losers: they replay the recorded outcome.
    for (const r of results) {
      if (r.status === 'error') {
        const replayed = await attempt()
        expect(replayed.status).toBe('ok')
      }
    }
    const rows = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM contact_tasks WHERE location_id = $1', [loc])
    expect(rows[0]?.n).toBe(1)
  } finally {
    await pool.end()
  }
})
