import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { PgliteDatabase } from '../db/pglite-database'
import type { WorkflowEvent } from '../jobs/workflow-dispatcher'
import { drainOutbox } from '../jobs/outbox-relay'
import { OutboxRepo } from './outbox-repo'

const SCHEMA = readFileSync(fileURLToPath(new URL('../../db/schema.sql', import.meta.url)), 'utf8')

async function setup() {
  const pg = new PGlite()
  await pg.exec(SCHEMA)
  const db = new PgliteDatabase(pg)
  await db.query("INSERT INTO locations (id, name, slug) VALUES ('locA','A','a')")
  return db
}

test('insert is stable-idempotent: re-inserting the same intent is a no-op', async () => {
  const db = await setup()
  const repo = new OutboxRepo(db, 'locA')
  const input = { id: 'booking:a1', aggregate: 'appointment', aggregateId: 'a1', event: 'appointment_booked' as const, payload: { contactId: 'c1' } }
  await repo.insert(input)
  await repo.insert(input)
  const rows = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM outbox')
  expect(rows[0]?.n).toBe(1)
})

test('drainOutbox dispatches pending rows with the outbox id as event_id, then marks sent', async () => {
  const db = await setup()
  const repo = new OutboxRepo(db, 'locA')
  await repo.insert({ id: 'booking:a1', aggregate: 'appointment', aggregateId: 'a1', event: 'appointment_booked', payload: { contactId: 'c1' } })
  const events: WorkflowEvent[] = []
  const out = await drainOutbox(db, 'locA', (e) => {
    events.push(e)
  })
  expect(out).toEqual({ sent: 1, failed: 0 })
  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({
    locationId: 'locA',
    triggerType: 'appointment_booked',
    contactId: 'c1',
    eventId: 'booking:a1',
  })
  const rows = await db.query<{ status: string }>('SELECT status FROM outbox WHERE id = $1', ['booking:a1'])
  expect(rows[0]?.status).toBe('sent')
})

test('drainOutbox parks throwing dispatches for retry with backoff, never losing them', async () => {
  const db = await setup()
  const repo = new OutboxRepo(db, 'locA')
  await repo.insert({ id: 'booking:a1', aggregate: 'appointment', aggregateId: 'a1', event: 'appointment_booked', payload: {} })
  const out = await drainOutbox(db, 'locA', () => {
    throw new Error('dispatcher down')
  })
  expect(out).toEqual({ sent: 0, failed: 1 })
  const rows = await db.query<{ status: string; attempts: number }>(
    'SELECT status, attempts FROM outbox WHERE id = $1',
    ['booking:a1'],
  )
  expect(rows[0]).toMatchObject({ status: 'pending', attempts: 1 })
})

test('claimDue skips future rows and reclaims stale sending rows', async () => {
  const db = await setup()
  const repo = new OutboxRepo(db, 'locA')
  await repo.insert({ id: 'future', aggregate: 'a', aggregateId: 'x', event: 'appointment_booked', payload: {} })
  await db.query("UPDATE outbox SET available_at = now() + make_interval(hours => 1) WHERE id = 'future'")
  await repo.insert({ id: 'stuck', aggregate: 'a', aggregateId: 'y', event: 'appointment_booked', payload: {} })
  await db.query("UPDATE outbox SET status = 'sending', updated_at = now() - make_interval(hours => 1) WHERE id = 'stuck'")
  const claimed = await db.withTransaction(async (tx) => {
    return new OutboxRepo(tx, 'locA').claimDue(25, 300_000)
  })
  expect(claimed.map((r) => r.id)).toEqual(['stuck'])
})

test('locationsWithPending lists only locations holding deliverable rows', async () => {
  const db = await setup()
  await db.query("INSERT INTO locations (id, name, slug) VALUES ('locB','B','b')")
  await new OutboxRepo(db, 'locA').insert({ id: 'a1', aggregate: 'a', aggregateId: 'x', event: 'e', payload: {} })
  await new OutboxRepo(db, 'locB').insert({ id: 'b1', aggregate: 'a', aggregateId: 'y', event: 'e', payload: {} })
  await db.query("UPDATE outbox SET status = 'sent' WHERE id = 'b1'")
  expect(await OutboxRepo.locationsWithPending(db)).toEqual(['locA'])
})

test('R13-04: a location with only stale sending rows is discovered and recovered by the sweep', async () => {
  const db = await setup()
  await db.query("INSERT INTO locations (id, name, slug) VALUES ('locB','B','b')")
  // locB holds ONLY a stale sending row (crashed relay); locA holds nothing.
  await new OutboxRepo(db, 'locB').insert({
    id: 'stuck-b',
    aggregate: 'appointment',
    aggregateId: 'appt1',
    event: 'appointment_booked',
    payload: { contactId: 'c1' },
  })
  await db.query("UPDATE outbox SET status = 'sending', updated_at = now() - make_interval(hours => 1) WHERE id = 'stuck-b'")
  // Discovery (the sweeper's fan-out) must see locB despite zero pending rows.
  expect(await OutboxRepo.locationsWithPending(db)).toEqual(['locB'])
  // And the normal sweep path reclaims + dispatches it exactly once.
  const seen: WorkflowEvent[] = []
  const first = await drainOutbox(db, 'locB', async (e) => void seen.push(e))
  expect(first).toEqual({ sent: 1, failed: 0 })
  const second = await drainOutbox(db, 'locB', async (e) => void seen.push(e))
  expect(second).toEqual({ sent: 0, failed: 0 })
  expect(seen).toHaveLength(1)
  expect(seen[0]).toMatchObject({ locationId: 'locB', eventId: 'stuck-b' })
})
