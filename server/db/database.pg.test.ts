/**
 * PgDatabase.withTransaction against real PostgreSQL 18.7: commit, rollback,
 * nested join, error propagation, and client release back to the pool.
 * Runs via `task test:pg`.
 */
import { inject } from 'vitest'
import { Pool } from 'pg'
import { type Database, PgDatabase } from './database'

const baseUrl: string = inject('pgTestUrl') ?? process.env.OPENLEVEL_PG_TEST_URL ?? ''
if (baseUrl === '') throw new Error('pgTestUrl not provided — run via task test:pg')

let tableCounter = 0
async function freshTxDb() {
  // Permanent (not TEMPORARY) table: temp tables are session-scoped and the
  // transaction checks out its own pooled connection. Container is disposable.
  const table = `txw_${process.pid}_${tableCounter++}`
  const pool = new Pool({ connectionString: baseUrl, max: 2 })
  await pool.query(`CREATE TABLE ${table} (id text PRIMARY KEY, n int NOT NULL)`)
  return { pool, db: new PgDatabase(pool), table }
}

test('pg withTransaction commits and releases the client', async () => {
  const { pool, db, table } = await freshTxDb()
  try {
    const out = await db.withTransaction(async (tx) => {
      await tx.query(`INSERT INTO ${table} (id, n) VALUES ('a', 1)`)
      return 'ok'
    })
    expect(out).toBe('ok')
    expect(await db.query(`SELECT n FROM ${table} WHERE id = $1`, ['a'])).toEqual([{ n: 1 }])
    expect(pool.totalCount).toBe(1)
    expect(pool.idleCount).toBe(1)
  } finally {
    await pool.end()
  }
})

test('pg withTransaction rolls back on throw and releases the client', async () => {
  const { pool, db, table } = await freshTxDb()
  try {
    await expect(
      db.withTransaction(async (tx) => {
        await tx.query(`INSERT INTO ${table} (id, n) VALUES ('a', 1)`)
        throw new Error('abort')
      }),
    ).rejects.toThrow('abort')
    expect(await db.query('SELECT count(*)::int AS n FROM ' + table)).toEqual([{ n: 0 }])
    expect(pool.idleCount).toBe(1)
  } finally {
    await pool.end()
  }
})

test('pg nested withTransaction via the pool handle joins the outer transaction', async () => {
  const { pool, db, table } = await freshTxDb()
  try {
    await expect(
      db.withTransaction(async () => {
        await db.query(`INSERT INTO ${table} (id, n) VALUES ('a', 1)`)
        // Deliberately nesting through the pool-level handle, not the tx
        // handle: the ambient context must still join (never a second txn).
        await db.withTransaction(async (inner: Database) => {
          await inner.query(`INSERT INTO ${table} (id, n) VALUES ('b', 2)`)
          throw new Error('inner abort')
        })
      }),
    ).rejects.toThrow('inner abort')
    expect(await db.query(`SELECT count(*)::int AS n FROM ${table}`)).toEqual([{ n: 0 }])
  } finally {
    await pool.end()
  }
})

test('pg nested withTransaction joins: inner abort wipes the outer writes', async () => {
  const { pool, db, table } = await freshTxDb()
  try {
    await expect(
      db.withTransaction(async (tx) => {
        await tx.query(`INSERT INTO ${table} (id, n) VALUES ('a', 1)`)
        await tx.withTransaction(async (inner: Database) => {
          await inner.query(`INSERT INTO ${table} (id, n) VALUES ('b', 2)`)
          throw new Error('inner abort')
        })
      }),
    ).rejects.toThrow('inner abort')
    expect(await db.query('SELECT count(*)::int AS n FROM ' + table)).toEqual([{ n: 0 }])
  } finally {
    await pool.end()
  }
})
