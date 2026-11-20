/**
 * Idempotency under real concurrency (FIND-07, G3): two simultaneous holders
 * of the same key must produce exactly one execution, and a campaign claim
 * race must produce exactly one winner. PGlite cannot run true concurrency
 * (single connection), so this lives in `task test:pg`.
 */
import { readFileSync } from 'node:fs'
import { inject } from 'vitest'
import { Pool } from 'pg'
import { PgDatabase } from '../db/database'
import { IdempotencyInProgress, payloadHash, withIdempotency } from './idempotency'

const baseUrl: string = inject('pgTestUrl') ?? process.env.OPENLEVEL_PG_TEST_URL ?? ''
if (baseUrl === '') throw new Error('pgTestUrl not provided — run via task test:pg')

const SCHEMA = readFileSync(new URL('../../db/schema.sql', import.meta.url), 'utf8')

beforeAll(async () => {
  // One shared schema for the file (idempotent: safe alongside other files
  // using the same disposable container); tests isolate by unique locations.
  const pool = new Pool({ connectionString: baseUrl })
  try {
    await pool.query(SCHEMA)
  } finally {
    await pool.end()
  }
})

async function setup() {
  const pool = new Pool({ connectionString: baseUrl, max: 4 })
  const tag = `idem_${process.pid}_${Math.floor(Math.random() * 1e9)}`
  await pool.query(`INSERT INTO locations (id, name, slug) VALUES ($1, 'T', $1)`, [tag])
  return { pool, db: new PgDatabase(pool), loc: tag }
}

test('concurrent same-key holders execute exactly once; the loser gets 409', async () => {
  const { pool, db, loc } = await setup()
  try {
    let executions = 0
    const scope = { locationId: loc, operation: 'op', key: 'race', payload: { n: 1 } }
    const attempt = () =>
      withIdempotency(db, scope, async () => {
        executions += 1
        await new Promise((r) => setTimeout(r, 200))
        return 'winner-result'
      })
    const [a, b] = await Promise.allSettled([attempt(), attempt()])
    const fulfilled = [a, b].filter((r): r is PromiseFulfilledResult<{ result: string; reused: boolean }> => r.status === 'fulfilled')
    const rejected = [a, b].filter((r) => r.status === 'rejected')
    expect(executions).toBe(1)
    expect(fulfilled).toHaveLength(1)
    expect(fulfilled[0]?.value).toEqual({ result: 'winner-result', reused: false })
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(IdempotencyInProgress)
  } finally {
    await pool.end()
  }
})

test('concurrent stale-takeover attempts still execute exactly once', async () => {
  const { pool, db, loc } = await setup()
  try {
    await db.query(
      `INSERT INTO idempotency_keys (location_id, operation, key, payload_hash, status, updated_at)
       VALUES ($1, 'op', 'stale', $2, 'in_progress', now() - make_interval(mins => 10))`,
      [loc, payloadHash({ n: 1 })],
    )
    let executions = 0
    const scope = { locationId: loc, operation: 'op', key: 'stale', payload: { n: 1 } }
    const attempt = () =>
      withIdempotency(
        db,
        scope,
        async () => {
          executions += 1
          await new Promise((r) => setTimeout(r, 200))
          return 'took-over'
        },
        { staleAfterMs: 1000 },
      )
    const results = await Promise.allSettled([attempt(), attempt()])
    expect(executions).toBe(1)
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1)
  } finally {
    await pool.end()
  }
})
