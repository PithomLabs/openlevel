/**
 * Concurrent contact enrichment on real PostgreSQL (R14-09): twins racing
 * to enrich the same contact must converge onto one row (array_append is
 * statement-atomic — no lost update, no split), and twins racing to create
 * the same new identity must collapse onto one row via the match_key race
 * path. Runs via `task test:pg`.
 */
import { readFileSync } from 'node:fs'
import { Pool } from 'pg'
import { inject } from 'vitest'
import { PgDatabase } from '../db/database'
import { ContactsRepo } from './contacts-repo'

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
  const loc = `cx_${process.pid}_${Math.floor(Math.random() * 1e9)}`
  await db.query('INSERT INTO locations (id, name, slug) VALUES ($1, $1, $1)', [loc])
  return { pool, db, loc }
}

test('R14-09: twins enriching different emails never split — one row, loser 409s or both land', async () => {
  const { pool, db, loc } = await setup()
  try {
    const repo = new ContactsRepo(db, loc)
    const seed = await repo.upsertByMatch({ name: 'Twin Target', phone: '+15551237777' }, 'seed')
    expect(seed.created).toBe(true)
    // Timing decides the legal outcome: twins that both read the empty
    // emails array append compatibly (array_append converges); a twin that
    // reads AFTER its sibling committed sees a populated-different email
    // and 409s. Both are correct — a split row or silent drop is not.
    const settled = await Promise.allSettled([
      repo.upsertByMatch({ phone: '+15551237777', email: 'twin-a@example.com' }, 'twin-a'),
      repo.upsertByMatch({ phone: '+15551237777', email: 'twin-b@example.com' }, 'twin-b'),
    ])
    for (const s of settled) {
      if (s.status === 'fulfilled') {
        expect(s.value.contact.id).toBe(seed.contact.id)
        expect(s.value.created).toBe(false)
      } else {
        expect(s.reason).toMatchObject({ name: 'ContactIdentityConflict', code: 'identity_conflict' })
      }
    }
    const rows = await db.query<{ id: string; emails: string[] }>(
      'SELECT id, emails FROM contacts WHERE location_id = $1',
      [loc],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.emails.length).toBeGreaterThanOrEqual(1)
    for (const email of rows[0]?.emails ?? []) {
      expect(['twin-a@example.com', 'twin-b@example.com']).toContain(email)
    }
  } finally {
    await pool.end()
  }
})

test('R14-09: twins enriching the SAME email stay idempotent — one row, one address', async () => {
  const { pool, db, loc } = await setup()
  try {
    const repo = new ContactsRepo(db, loc)
    await repo.upsertByMatch({ name: 'Twin Target', phone: '+15551237777' }, 'seed')
    await Promise.all([
      repo.upsertByMatch({ phone: '+15551237777', email: 'same@example.com' }, 'twin-a'),
      repo.upsertByMatch({ phone: '+15551237777', email: 'same@example.com' }, 'twin-b'),
    ])
    const rows = await db.query<{ id: string; emails: string[] }>(
      'SELECT id, emails FROM contacts WHERE location_id = $1',
      [loc],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.emails).toEqual(['same@example.com'])
  } finally {
    await pool.end()
  }
})

test('R14-09: twins creating the same new identity collapse — one row, exactly one created', async () => {
  const { pool, db, loc } = await setup()
  try {
    const repo = new ContactsRepo(db, loc)
    const [a, b] = await Promise.all([
      repo.upsertByMatch({ name: 'Fresh Twin', phone: '+15551236666' }, 'twin-a'),
      repo.upsertByMatch({ name: 'Fresh Twin', phone: '+15551236666' }, 'twin-b'),
    ])
    expect(a.contact.id).toBe(b.contact.id)
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1)
    const rows = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM contacts WHERE location_id = $1', [loc])
    expect(rows[0]?.n).toBe(1)
  } finally {
    await pool.end()
  }
})
