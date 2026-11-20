/**
 * Concurrent outbox claiming on real PostgreSQL (R14-09): two relays racing
 * claimDue must divide rows (SKIP LOCKED) — never double-claim — and a
 * stale `sending` row must be reclaimed by exactly one twin. PGlite
 * serializes on one connection, so only real Postgres proves this. Runs via
 * `task test:pg`.
 */
import { readFileSync } from 'node:fs'
import { Pool } from 'pg'
import { inject } from 'vitest'
import { PgDatabase } from '../db/database'
import { OUTBOX_STALE_AFTER_MS, OutboxRepo } from './outbox-repo'

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

async function setup() {
  const pool = new Pool({ connectionString: baseUrl, max: 4 })
  const db = new PgDatabase(pool)
  const loc = `ob_${process.pid}_${Math.floor(Math.random() * 1e9)}`
  await db.query('INSERT INTO locations (id, name, slug) VALUES ($1, $1, $1)', [loc])
  return { pool, db, loc }
}

test('R14-09: racing relays divide due rows — disjoint claims, complete union, none stranded', async () => {
  const { pool, db, loc } = await setup()
  try {
    const repo = new OutboxRepo(db, loc)
    for (let i = 0; i < 10; i++) {
      await repo.insert({ id: `ob-twin-${i}`, aggregate: 'contact', aggregateId: 'c1', event: 'contact_created' })
    }
    // Two relays, separate connections: claimDue MUST run in a txn (the
    // claim commits with the caller), so each twin transacts separately.
    const claim = () => db.withTransaction((tx) => new OutboxRepo(tx, loc).claimDue(10, OUTBOX_STALE_AFTER_MS))
    const [a, b] = await Promise.all([claim(), claim()])
    const idsA = new Set(a.map((r) => r.id))
    const idsB = new Set(b.map((r) => r.id))
    // Disjoint: no row claimed twice.
    for (const id of idsA) expect(idsB.has(id)).toBe(false)
    // Complete: every due row claimed exactly once across both twins.
    expect(idsA.size + idsB.size).toBe(10)
    // Nothing left due: a third sweep finds no work.
    const rest = await db.withTransaction((tx) => new OutboxRepo(tx, loc).claimDue(10, OUTBOX_STALE_AFTER_MS))
    // Claimed rows are 'sending' (fresh, not stale) — invisible to reclaim.
    expect(rest).toHaveLength(0)
  } finally {
    await pool.end()
  }
})

test('R14-09: a stale sending row is reclaimed by exactly one racing twin', async () => {
  const { pool, db, loc } = await setup()
  try {
    const repo = new OutboxRepo(db, loc)
    await repo.insert({ id: 'ob-stale-1', aggregate: 'contact', aggregateId: 'c1', event: 'contact_created' })
    await db.query("UPDATE outbox SET status = 'sending', updated_at = now() - make_interval(hours => 2) WHERE id = 'ob-stale-1'")
    const claim = () => db.withTransaction((tx) => new OutboxRepo(tx, loc).claimDue(10, 60_000))
    const [a, b] = await Promise.all([claim(), claim()])
    expect(a.length + b.length).toBe(1)
  } finally {
    await pool.end()
  }
})
