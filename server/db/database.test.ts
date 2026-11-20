import { PGlite } from '@electric-sql/pglite'
import { FakeDatabase } from './fake-database'
import { PgliteDatabase } from './pglite-database'

test('fake records queries and returns canned rows', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: '1' }])
  const rows = await db.query<{ id: string }>('SELECT 1 WHERE x=$1', ['a'])
  expect(rows).toEqual([{ id: '1' }])
  expect(db.calls[0]).toEqual({ sql: 'SELECT 1 WHERE x=$1', params: ['a'] })
})

test('fake returns empty array when nothing enqueued', async () => {
  const db = new FakeDatabase()
  const rows = await db.query('SELECT 1')
  expect(rows).toEqual([])
  expect(db.calls[0]).toEqual({ sql: 'SELECT 1', params: [] })
})

test('fake withTransaction runs inline and propagates the return value', async () => {
  const db = new FakeDatabase()
  await expect(db.withTransaction(async (tx) => tx.query('SELECT 1'))).resolves.toEqual([])
  expect(db.calls).toEqual([{ sql: 'SELECT 1', params: [] }])
})

test('fake withTransaction propagates throws', async () => {
  const db = new FakeDatabase()
  await expect(db.withTransaction(async () => Promise.reject(new Error('nope')))).rejects.toThrow('nope')
})

async function pgliteDb() {
  const pg = new PGlite()
  await pg.exec('CREATE TABLE t (id text PRIMARY KEY, n int NOT NULL)')
  return new PgliteDatabase(pg)
}

test('pglite withTransaction commits on success', async () => {
  const db = await pgliteDb()
  const out = await db.withTransaction(async (tx) => {
    await tx.query("INSERT INTO t (id, n) VALUES ('a', 1)")
    return 'ok'
  })
  expect(out).toBe('ok')
  expect(await db.query('SELECT n FROM t WHERE id = $1', ['a'])).toEqual([{ n: 1 }])
})

test('pglite withTransaction rolls back on throw, then the connection is usable', async () => {
  const db = await pgliteDb()
  await expect(
    db.withTransaction(async (tx) => {
      await tx.query("INSERT INTO t (id, n) VALUES ('a', 1)")
      throw new Error('abort')
    }),
  ).rejects.toThrow('abort')
  expect(await db.query('SELECT count(*)::int AS n FROM t')).toEqual([{ n: 0 }])
  // Usable afterwards (no wedged transaction state).
  await db.query("INSERT INTO t (id, n) VALUES ('b', 2)")
  expect(await db.query('SELECT n FROM t WHERE id = $1', ['b'])).toEqual([{ n: 2 }])
})

test('pglite concurrent withTransaction calls on one instance serialize safely', async () => {
  const db = await pgliteDb()
  const slow = db.withTransaction(async (tx) => {
    await tx.query("INSERT INTO t (id, n) VALUES ('slow', 1)")
    await new Promise((r) => setTimeout(r, 100))
  })
  const fast = db.withTransaction(async (tx) => {
    await tx.query("INSERT INTO t (id, n) VALUES ('fast', 2)")
  })
  await expect(Promise.all([slow, fast])).resolves.toHaveLength(2)
  expect(await db.query('SELECT count(*)::int AS n FROM t')).toEqual([{ n: 2 }])
})

test('pglite nested withTransaction joins the outer transaction', async () => {
  const db = await pgliteDb()
  await db.withTransaction(async (tx) => {
    await tx.query("INSERT INTO t (id, n) VALUES ('a', 1)")
    await expect(
      tx.withTransaction(async (inner) => {
        await inner.query("INSERT INTO t (id, n) VALUES ('b', 2)")
        throw new Error('inner abort')
      }),
    ).rejects.toThrow('inner abort')
    // Inner abort rolls back the whole (joined) transaction.
    await expect(tx.query('SELECT 1')).rejects.toThrow()
  }).catch(() => {})
  expect(await db.query('SELECT count(*)::int AS n FROM t')).toEqual([{ n: 0 }])
})
