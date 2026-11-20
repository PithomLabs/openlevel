/**
 * R13-10: one logical proposal confirms exactly once. Keyed confirms run the
 * verb's mutation + idempotency completion in one transaction (DB verbs) or
 * behind the proposal nonce (send_text); retries replay, twins collapse,
 * contradictory payloads 409. Uses real PGlite: transactions, unique
 * violations, and phantoms are the points under test — FakeDatabase cannot
 * prove them.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import type { Database } from '../db/database'
import { PgliteDatabase } from '../db/pglite-database'
import { IdempotencyConflict } from './idempotency'
import { confirmOperatorWrite } from './operator-tools'

const SCHEMA = readFileSync(fileURLToPath(new URL('../../db/schema.sql', import.meta.url)), 'utf8')

async function setup() {
  const pg = new PGlite()
  await pg.exec(SCHEMA)
  const db = new PgliteDatabase(pg)
  const loc = 'locA'
  await db.query("INSERT INTO locations (id, name, slug) VALUES ($1,'A','a')", [loc])
  await db.query(
    "INSERT INTO contacts (id, location_id, name, phones, emails) VALUES ('c1',$1,'Jane Doe', $2, $3)",
    [loc, ['+16025551234'], ['jane@example.com']],
  )
  await db.query("INSERT INTO calendars (id, location_id, name) VALUES ('cal1',$1,'Main')", [loc])
  await db.query("INSERT INTO pipelines (id, location_id, name) VALUES ('p1',$1,'Sales')", [loc])
  await db.query(
    "INSERT INTO pipeline_stages (id, location_id, pipeline_id, name) VALUES ('s1',$1,'p1','New'), ('s2',$1,'p1','Won')",
    [loc],
  )
  await db.query(
    "INSERT INTO opportunities (id, location_id, pipeline_id, stage_id, name, status) VALUES ('o1',$1,'p1','s1','Deal', 'open')",
    [loc],
  )
  return { db, loc }
}

const confirm = (db: Database, loc: string, verb: string, params: Record<string, unknown>, key?: string) =>
  confirmOperatorWrite(
    { db, locationId: loc },
    { verb, params },
    key === undefined ? undefined : { idempotencyKey: key },
  )

test('R13-10: same proposal twice sequentially executes once and replays the message', async () => {
  const { db, loc } = await setup()
  const first = await confirm(db, loc, 'create_task', { contactId: 'c1', title: 'Call back' }, 'k-task-1')
  const second = await confirm(db, loc, 'create_task', { contactId: 'c1', title: 'Call back' }, 'k-task-1')
  expect(first.ok).toBe(true)
  expect(second.message).toBe(first.message)
  const rows = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM contact_tasks WHERE location_id = $1', [loc])
  expect(rows[0]?.n).toBe(1)
})

test('R14-02: same key + same proposal but a DIFFERENT actor is a 409, never a cross replay', async () => {
  const { db, loc } = await setup()
  const run = (actor: string) =>
    confirmOperatorWrite(
      { db, locationId: loc, actor },
      { verb: 'create_task', params: { contactId: 'c1', title: 'Call back' } },
      { idempotencyKey: 'k-actor-1' },
    )
  const first = await run('op1')
  expect(first.ok).toBe(true)
  // Same operator retrying still replays.
  const replay = await run('op1')
  expect(replay.message).toBe(first.message)
  // A different operator under the same key string: conflict, not op1's result.
  await expect(run('op2')).rejects.toThrow(IdempotencyConflict)
  const rows = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM contact_tasks WHERE location_id = $1', [loc])
  expect(rows[0]?.n).toBe(1)
})

test('R13-10: keyed booking writes once, dispatches once with the stable id, replays after', async () => {
  const { db, loc } = await setup()
  const events: unknown[] = []
  const run = (key: string) =>
    confirmOperatorWrite(
      { db, locationId: loc, dispatch: async (e) => void events.push(e) },
      { verb: 'book_appointment', params: { contactId: 'c1', start: '2026-06-20T17:00:00Z' } },
      { idempotencyKey: key },
    )
  const first = await run('k-book-1')
  const second = await run('k-book-1')
  expect(first.ok).toBe(true)
  expect(second.message).toBe(first.message)
  const appts = await db.query<{ id: string }>('SELECT id FROM appointments WHERE location_id = $1', [loc])
  expect(appts).toHaveLength(1)
  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({ eventId: `booking:${appts[0]?.id}` })
  const outbox = await db.query<{ id: string }>("SELECT id FROM outbox WHERE location_id = $1 AND aggregate = 'appointment'", [loc])
  expect(outbox).toHaveLength(1)
  expect(outbox[0]?.id).toBe(`booking:${appts[0]?.id}`)
})

test('R13-10: tag/move/status verbs replay without re-writing', async () => {
  const { db, loc } = await setup()
  const tag1 = await confirm(db, loc, 'tag_contact', { contactId: 'c1', tag: 'vip' }, 'k-tag-1')
  const tag2 = await confirm(db, loc, 'tag_contact', { contactId: 'c1', tag: 'vip' }, 'k-tag-1')
  expect(tag2.message).toBe(tag1.message)
  const move1 = await confirm(db, loc, 'move_opportunity', { opportunityId: 'o1', stageId: 's2' }, 'k-move-1')
  const move2 = await confirm(db, loc, 'move_opportunity', { opportunityId: 'o1', stageId: 's2' }, 'k-move-1')
  expect(move2.message).toBe(move1.message)
  const keys = await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM idempotency_keys WHERE location_id = $1 AND operation = 'operator-confirm' AND status = 'completed'",
    [loc],
  )
  expect(keys[0]?.n).toBe(2)
})

test('R13-10: same key with contradictory payload is a 409 conflict, never a second write', async () => {
  const { db, loc } = await setup()
  await confirm(db, loc, 'create_task', { contactId: 'c1', title: 'First' }, 'k-conflict-1')
  await expect(
    confirmOperatorWrite({ db, locationId: loc }, { verb: 'create_task', params: { contactId: 'c1', title: 'OTHER' } }, {
      idempotencyKey: 'k-conflict-1',
    }),
  ).rejects.toThrow(IdempotencyConflict)
  const rows = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM contact_tasks WHERE location_id = $1', [loc])
  expect(rows[0]?.n).toBe(1)
})

test('R13-10: stale crashed claim is taken over and executes (no stuck keys)', async () => {
  const { db, loc } = await setup()
  // First pass through the real path records the true payload hash.
  const first = await confirm(db, loc, 'create_task', { contactId: 'c1', title: 'Recovered' }, 'k-stale-1')
  expect(first.ok).toBe(true)
  // Simulate a crash between claim and commit: flip the real claim row back
  // to a stale in_progress claim (hash preserved), business effect removed.
  await db.query(`DELETE FROM contact_tasks WHERE location_id = $1`, [loc])
  await db.query(
    `UPDATE idempotency_keys SET status = 'in_progress', updated_at = now() - make_interval(mins => 10)
     WHERE location_id = $1 AND operation = 'operator-confirm' AND key = 'k-stale-1'`,
    [loc],
  )
  const res = await confirm(db, loc, 'create_task', { contactId: 'c1', title: 'Recovered' }, 'k-stale-1')
  expect(res.ok).toBe(true)
  expect(res.message).toBe(first.message)
  const rows = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM contact_tasks WHERE location_id = $1', [loc])
  expect(rows[0]?.n).toBe(1)
  const keys = await db.query<{ status: string }>(
    `SELECT status FROM idempotency_keys WHERE location_id = $1 AND operation = 'operator-confirm' AND key = 'k-stale-1'`,
    [loc],
  )
  expect(keys[0]?.status).toBe('completed')
})

test('R13-10: same key in another location is an independent operation (cross-tenant)', async () => {
  const { db, loc } = await setup()
  await db.query("INSERT INTO locations (id, name, slug) VALUES ('locB','B','b')")
  await db.query("INSERT INTO contacts (id, location_id, name) VALUES ('cB','locB','Bee')")
  await confirm(db, loc, 'create_task', { contactId: 'c1', title: 'A-task' }, 'k-shared')
  await confirm(db, 'locB', 'create_task', { contactId: 'cB', title: 'B-task' }, 'k-shared')
  const rows = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM contact_tasks')
  expect(rows[0]?.n).toBe(2)
})

test('R13-10: keyed send_text calls the gateway once; the retry replays without redialing', async () => {
  const { db, loc } = await setup()
  let calls = 0
  const sendText = async () => {
    calls += 1
    return { ok: true as const, messageId: 'gw-1' }
  }
  const first = await confirmOperatorWrite(
    { db, locationId: loc, sendText },
    { verb: 'send_text', params: { contactId: 'c1', body: 'Hi Jane', nonce: 'n-dedupe' } },
    { idempotencyKey: 'k-text-1' },
  )
  const second = await confirmOperatorWrite(
    { db, locationId: loc, sendText },
    { verb: 'send_text', params: { contactId: 'c1', body: 'Hi Jane', nonce: 'n-dedupe' } },
    { idempotencyKey: 'k-text-1' },
  )
  expect(first.ok).toBe(true)
  expect(second.message).toBe(first.message)
  expect(calls).toBe(1)
})

test('R13-10: unkeyed confirms keep legacy execute-once-per-call behavior (documented)', async () => {
  const { db, loc } = await setup()
  await confirm(db, loc, 'create_task', { contactId: 'c1', title: 'Legacy' })
  await confirm(db, loc, 'create_task', { contactId: 'c1', title: 'Legacy' })
  const rows = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM contact_tasks WHERE location_id = $1', [loc])
  expect(rows[0]?.n).toBe(2)
})

test('R14-08: per-verb fault matrix — a faulted keyed confirm rejects and commits nothing partial', async () => {
  // One row per DB verb: fault the verb's write (for the multi-write booking
  // verb, the LAST write — proving partial rollback), then prove the reject
  // left no committed trace. Fresh database per verb.
  const matrix: Array<{
    verb: string
    params: Record<string, unknown>
    faultRe: RegExp
    verify: (db: Database, loc: string) => Promise<void>
  }> = [
    {
      verb: 'tag_contact',
      params: { contactId: 'c1', tag: 'vip' },
      faultRe: /UPDATE contacts/,
      verify: async (db, loc) => {
        const rows = await db.query<{ tags: string[] }>('SELECT tags FROM contacts WHERE location_id = $1 AND id = $2', [loc, 'c1'])
        expect(rows[0]?.tags ?? []).not.toContain('vip')
      },
    },
    {
      verb: 'untag_contact',
      params: { contactId: 'c1', tag: 'vip' },
      faultRe: /UPDATE contacts/,
      verify: async (db, loc) => {
        // Seeded below via a clean tag; the faulted untag must leave it.
        const rows = await db.query<{ tags: string[] }>('SELECT tags FROM contacts WHERE location_id = $1 AND id = $2', [loc, 'c1'])
        expect(rows[0]?.tags ?? []).toContain('vip')
      },
    },
    {
      verb: 'create_task',
      params: { contactId: 'c1', title: 'Doomed task' },
      faultRe: /INSERT INTO contact_tasks/,
      verify: async (db, loc) => {
        const rows = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM contact_tasks WHERE location_id = $1', [loc])
        expect(rows[0]?.n).toBe(0)
      },
    },
    {
      verb: 'move_opportunity',
      params: { opportunityId: 'o1', stageId: 's2' },
      faultRe: /UPDATE opportunities/,
      verify: async (db, loc) => {
        const rows = await db.query<{ stage_id: string }>('SELECT stage_id FROM opportunities WHERE location_id = $1 AND id = $2', [loc, 'o1'])
        expect(rows[0]?.stage_id).toBe('s1')
      },
    },
    {
      verb: 'set_opportunity_status',
      params: { opportunityId: 'o1', status: 'won' },
      faultRe: /UPDATE opportunities/,
      verify: async (db, loc) => {
        const rows = await db.query<{ status: string }>('SELECT status FROM opportunities WHERE location_id = $1 AND id = $2', [loc, 'o1'])
        expect(rows[0]?.status).toBe('open')
      },
    },
    {
      verb: 'book_appointment',
      params: { contactId: 'c1', start: '2026-06-20T17:00:00Z' },
      faultRe: /INSERT INTO outbox/,
      verify: async (db, loc) => {
        // The appointment + timeline writes precede the faulted outbox write:
        // atomicity must roll them back too.
        const rows = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM appointments WHERE location_id = $1', [loc])
        expect(rows[0]?.n).toBe(0)
        const events = await db.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM timeline_events WHERE contact_id = 'c1' AND type = 'appointment_booked'",
        )
        expect(events[0]?.n).toBe(0)
      },
    },
  ]
  for (const [i, row] of matrix.entries()) {
    const { db, loc } = await setup()
    if (row.verb === 'untag_contact') {
      const seeded = await confirm(db, loc, 'tag_contact', { contactId: 'c1', tag: 'vip' })
      expect(seeded.ok).toBe(true)
    }
    const wrap = (inner: Database): Database => ({
      query: async <T>(sql: string, params?: unknown[]): Promise<T[]> => {
        if (row.faultRe.test(sql)) throw new Error(`injected ${row.verb} fault`)
        return inner.query<T>(sql, params)
      },
      withTransaction: <T>(fn: (tx: Database) => Promise<T>): Promise<T> => inner.withTransaction((tx) => fn(wrap(tx))),
    })
    await expect(
      confirmOperatorWrite({ db: wrap(db), locationId: loc }, { verb: row.verb, params: row.params }, { idempotencyKey: `k-fault-${i}` }),
    ).rejects.toThrow(`injected ${row.verb} fault`)
    await row.verify(db, loc)
    // The released key retries cleanly on the unfaulted db.
    const retry = await confirm(db, loc, row.verb, row.params, `k-fault-${i}`)
    expect(retry.ok).toBe(true)
  }
})

test('R14-08: send_text rail fault rejects loudly — rail called once, attempt row without an outcome row', async () => {
  const { db, loc } = await setup()
  let railCalls = 0
  await expect(
    confirmOperatorWrite(
      {
        db,
        locationId: loc,
        sendText: async () => {
          railCalls += 1
          throw new Error('gateway exploded')
        },
      },
      { verb: 'send_text', params: { contactId: 'c1', body: 'Hi', nonce: 'n-fault-1' } },
      { idempotencyKey: 'k-send-fault-1' },
    ),
  ).rejects.toThrow('gateway exploded')
  expect(railCalls).toBe(1)
  // The queued attempt row persisted (crash-safe bookkeeping); no outcome row
  // was recorded, so a retry re-attempts honestly instead of replaying a lie.
  const rows = await db.query<{ status: string }>(
    "SELECT payload->>'status' AS status FROM timeline_events WHERE contact_id = 'c1' AND type = 'outbound_text'",
  )
  expect(rows.map((r) => r.status)).toEqual(['queued'])
})

test('R13-10: completion commits with the mutation — faulting completion rolls everything back', async () => {
  const { db, loc } = await setup()
  // Fault the completion UPDATE wherever it runs, including inside the txn:
  // atomicity means the business write must roll back with it.
  const wrap = (inner: Database): Database => ({
    query: async <T>(sql: string, params?: unknown[]): Promise<T[]> => {
      if (/UPDATE idempotency_keys SET status = 'completed'/.test(sql)) throw new Error('injected post-write fault')
      return inner.query<T>(sql, params)
    },
    withTransaction: <T>(fn: (tx: Database) => Promise<T>): Promise<T> => inner.withTransaction((tx) => fn(wrap(tx))),
  })
  const faulting = wrap(db)
  await expect(
    confirmOperatorWrite({ db: faulting, locationId: loc }, { verb: 'create_task', params: { contactId: 'c1', title: 'Doomed' } }, {
      idempotencyKey: 'k-doomed-1',
    }),
  ).rejects.toThrow('injected post-write fault')
  // Atomic rollback: no task row, and the released key retries cleanly.
  const rows = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM contact_tasks WHERE location_id = $1', [loc])
  expect(rows[0]?.n).toBe(0)
  const retry = await confirm(db, loc, 'create_task', { contactId: 'c1', title: 'Doomed' }, 'k-doomed-1')
  expect(retry.ok).toBe(true)
})
