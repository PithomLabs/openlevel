import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { PgliteDatabase } from '../db/pglite-database'
import {
  IdempotencyConflict,
  IdempotencyInProgress,
  InvalidIdempotencyKey,
  canonicalJson,
  parseIdempotencyKey,
  payloadHash,
  withIdempotency,
} from './idempotency'

const SCHEMA = readFileSync(fileURLToPath(new URL('../../db/schema.sql', import.meta.url)), 'utf8')

async function setup() {
  const pg = new PGlite()
  await pg.exec(SCHEMA)
  const db = new PgliteDatabase(pg)
  await db.query("INSERT INTO locations (id, name, slug) VALUES ('locA','A','a'), ('locB','B','b')")
  return db
}

test('canonicalJson orders keys so equal payloads hash equally', () => {
  expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}')
  expect(payloadHash({ a: 1, b: 2 })).toBe(payloadHash({ b: 2, a: 1 }))
  expect(payloadHash({ a: 1 })).not.toBe(payloadHash({ a: 2 }))
})

test('first execution runs and records; repeat replays without re-executing', async () => {
  const db = await setup()
  let calls = 0
  const scope = { locationId: 'locA', operation: 'op', key: 'k1', payload: { n: 1 } }
  const first = await withIdempotency(db, scope, async () => {
    calls += 1
    return { v: 42 }
  })
  expect(first).toEqual({ result: { v: 42 }, reused: false })
  const second = await withIdempotency(db, scope, async () => {
    calls += 1
    return { v: 99 }
  })
  expect(second).toEqual({ result: { v: 42 }, reused: true })
  expect(calls).toBe(1)
})

test('same key with a different payload is a conflict, not silent reuse (G3)', async () => {
  const db = await setup()
  await withIdempotency(db, { locationId: 'locA', operation: 'op', key: 'k1', payload: { n: 1 } }, async () => 'a')
  await expect(
    withIdempotency(db, { locationId: 'locA', operation: 'op', key: 'k1', payload: { n: 2 } }, async () => 'b'),
  ).rejects.toThrow(IdempotencyConflict)
})

test('keys are scoped by tenant and operation (G3)', async () => {
  const db = await setup()
  await withIdempotency(db, { locationId: 'locA', operation: 'op', key: 'k', payload: 1 }, async () => 'a')
  // Same key, other tenant: independent execution.
  const other = await withIdempotency(db, { locationId: 'locB', operation: 'op', key: 'k', payload: 1 }, async () => 'b')
  expect(other).toEqual({ result: 'b', reused: false })
  // Same key, other operation: independent execution.
  const otherOp = await withIdempotency(
    db,
    { locationId: 'locA', operation: 'op2', key: 'k', payload: 1 },
    async () => 'c',
  )
  expect(otherOp).toEqual({ result: 'c', reused: false })
})

test('a failed execution releases the key so a retry re-executes', async () => {
  const db = await setup()
  const scope = { locationId: 'locA', operation: 'op', key: 'k1', payload: 1 }
  await expect(
    withIdempotency(db, scope, async () => {
      throw new Error('boom')
    }),
  ).rejects.toThrow('boom')
  let calls = 0
  const retry = await withIdempotency(db, scope, async () => {
    calls += 1
    return 'recovered'
  })
  expect(retry).toEqual({ result: 'recovered', reused: false })
  expect(calls).toBe(1)
})

test('a stale in-progress claim is taken over atomically', async () => {
  const db = await setup()
  const scope = { locationId: 'locA', operation: 'op', key: 'k1', payload: 1 }
  // Simulate a crashed claimant: in_progress row last touched long ago.
  const hash = payloadHash(1)
  await db.query(
    `INSERT INTO idempotency_keys (location_id, operation, key, payload_hash, status, updated_at)
     VALUES ('locA', 'op', 'k1', $1, 'in_progress', now() - make_interval(mins => 10))`,
    [hash],
  )
  let calls = 0
  const out = await withIdempotency(
    db,
    scope,
    async () => {
      calls += 1
      return 'took-over'
    },
    { staleAfterMs: 1000 },
  )
  expect(out).toEqual({ result: 'took-over', reused: false })
  expect(calls).toBe(1)
})

test('a failure after a twin completed preserves the completed record (N4 guarded release)', async () => {
  const db = await setup()
  const scope = { locationId: 'locA', operation: 'op', key: 'k1', payload: 1 }
  const hash = payloadHash(1)
  await db.query(
    `INSERT INTO idempotency_keys (location_id, operation, key, payload_hash, status, updated_at)
     VALUES ('locA', 'op', 'k1', $1, 'in_progress', now() - make_interval(mins => 10))`,
    [hash],
  )
  // We take over the stale claim, but the original claimant actually finished:
  // it flips the row to completed just before we fail. Our release must not
  // destroy its completed record.
  await expect(
    withIdempotency(
      db,
      scope,
      async () => {
        await db.query(
          `UPDATE idempotency_keys SET status = 'completed', result = '"twin-result"'::jsonb
           WHERE location_id = 'locA' AND operation = 'op' AND key = 'k1'`,
        )
        throw new Error('boom')
      },
      { staleAfterMs: 1000 },
    ),
  ).rejects.toThrow('boom')
  const rows = await db.query<{ status: string; result: unknown }>(
    `SELECT status, result FROM idempotency_keys WHERE location_id = 'locA' AND operation = 'op' AND key = 'k1'`,
  )
  expect(rows[0]?.status).toBe('completed')
  expect(rows[0]?.result).toBe('twin-result')
})

test('a fresh in-progress claim answers 409 without executing', async () => {
  const db = await setup()
  const hash = payloadHash(1)
  await db.query(
    `INSERT INTO idempotency_keys (location_id, operation, key, payload_hash, status)
     VALUES ('locA', 'op', 'k1', $1, 'in_progress')`,
    [hash],
  )
  let calls = 0
  await expect(
    withIdempotency(
      db,
      { locationId: 'locA', operation: 'op', key: 'k1', payload: 1 },
      async () => {
        calls += 1
        return 'x'
      },
      { staleAfterMs: 60_000 },
    ),
  ).rejects.toThrow(IdempotencyInProgress)
  expect(calls).toBe(0)
})

test('empty keys are a programmer error, refused loudly', async () => {
  const db = await setup()
  await expect(
    withIdempotency(db, { locationId: 'locA', operation: 'op', key: '', payload: 1 }, async () => 1),
  ).rejects.toThrow(/non-empty key/)
})

test('R14-01: parseIdempotencyKey validates client key shape', () => {
  expect(parseIdempotencyKey(undefined)).toBeNull()
  expect(parseIdempotencyKey('form-retry-1')).toBe('form-retry-1')
  expect(parseIdempotencyKey('  padded  ')).toBe('padded')
  expect(parseIdempotencyKey('x'.repeat(128))).toBe('x'.repeat(128))
  expect(() => parseIdempotencyKey('')).toThrow(InvalidIdempotencyKey)
  expect(() => parseIdempotencyKey('   ')).toThrow(InvalidIdempotencyKey)
  expect(() => parseIdempotencyKey('x'.repeat(129))).toThrow(InvalidIdempotencyKey)
  expect(() => parseIdempotencyKey('a\tb')).toThrow(InvalidIdempotencyKey)
  try {
    parseIdempotencyKey('')
    expect.unreachable('empty key must throw')
  } catch (err) {
    expect((err as InvalidIdempotencyKey).status).toBe(400)
  }
})
