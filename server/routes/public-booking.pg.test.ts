/**
 * Booking race on real PostgreSQL (FIND-09): two visitors firing for the same
 * slot in the same tick must yield exactly one booking — PGlite serializes,
 * so only real Postgres proves the unique index + transaction path under
 * true concurrency. Runs via `task test:pg`.
 */
import { readFileSync } from 'node:fs'
import { Hono } from 'hono'
import { inject } from 'vitest'
import { Pool } from 'pg'
import type { AppEnv } from '../app-env'
import { PgDatabase } from '../db/database'
import type { WorkflowEvent } from '../jobs/workflow-dispatcher'
import { CalendarsRepo } from '../repos/calendars-repo'
import { publicBookingRoute } from './public-booking'

const baseUrl: string = inject('pgTestUrl') ?? process.env.OPENLEVEL_PG_TEST_URL ?? ''
if (baseUrl === '') throw new Error('pgTestUrl not provided — run via task test:pg')

const SCHEMA = readFileSync(new URL('../../db/schema.sql', import.meta.url), 'utf8')
const NOW = new Date('2025-06-09T08:00:00Z')
const FIRST_SLOT = '2025-06-09T13:00:00.000Z'

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
  const loc = `bk_${process.pid}_${Math.floor(Math.random() * 1e9)}`
  await db.query(`INSERT INTO locations (id, name, slug) VALUES ($1, 'T', $1)`, [loc])
  const calRepo = new CalendarsRepo(db, loc)
  const cal = await calRepo.create({ name: 'Seller Consultations' })
  await calRepo.update(cal.id, {
    bookingEnabled: true,
    bookingSlug: 'cash-offer',
    timezone: 'America/New_York',
    durationMin: 30,
    slotIntervalMin: 0,
    bufferMin: 0,
    noticeMin: 0,
    rollingDays: 14,
    availability: [{ weekday: 1, start: '09:00', end: '12:00' }],
  })
  const events: WorkflowEvent[] = []
  const app = new Hono<AppEnv>()
  app.route(
    '/',
    publicBookingRoute({
      db,
      dispatch: (e) => {
        events.push(e)
      },
      now: () => NOW,
    }),
  )
  return { pool, db, loc, app, events }
}

test('concurrent same-slot bookings: exactly one 200, one 409, one row, one dispatch', async () => {
  const { pool, db, loc, app, events } = await setup()
  try {
    const book = (email: string) =>
      app.request(`/${loc}/cash-offer/book`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ start: FIRST_SLOT, end: '2025-06-09T13:30:00.000Z', name: 'V', email }),
      })
    const [a, b] = await Promise.all([book('a@example.com'), book('b@example.com')])
    expect([a.status, b.status].sort()).toEqual([200, 409])
    const rows = await db.query<{ id: string }>(
      "SELECT id FROM appointments WHERE starts_at = $1 AND status <> 'cancelled'",
      [FIRST_SLOT],
    )
    expect(rows).toHaveLength(1)
    // The winner dispatched exactly once, with the outbox row's stable id.
    expect(events).toHaveLength(1)
    expect(events[0]?.eventId).toBe(`booking:${rows[0]?.id}`)
    // Location-scoped: pg files share one server database across tests.
    const outbox = await db.query<{ id: string; status: string }>(
      'SELECT id, status FROM outbox WHERE location_id = $1',
      [loc],
    )
    expect(outbox).toHaveLength(1)
    expect(outbox[0]).toMatchObject({ id: `booking:${rows[0]?.id}`, status: 'pending' })
  } finally {
    await pool.end()
  }
})

test('N4 on real PG: same-key retry replays the committed booking; completion is atomic with it', async () => {
  const { pool, db, loc, app } = await setup()
  try {
    const book = () =>
      app.request(`/${loc}/cash-offer/book`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'n4pg-key-1' },
        body: JSON.stringify({
          start: FIRST_SLOT,
          end: '2025-06-09T13:30:00.000Z',
          name: 'V',
          email: 'v@example.com',
        }),
      })
    const first = await book()
    expect(first.status).toBe(200)
    const firstBody = (await first.json()) as { appointmentId: string }
    // The completion row and the booking are one atomic commit: both visible.
    const keys = await db.query<{ status: string; result: unknown }>(
      `SELECT status, result FROM idempotency_keys WHERE location_id = $1 AND operation = 'booking-create' AND key = 'n4pg-key-1'`,
      [loc],
    )
    expect(keys).toHaveLength(1)
    expect(keys[0]?.status).toBe('completed')
    expect(keys[0]?.result).toMatchObject({ appointmentId: firstBody.appointmentId })
    // A retry (e.g. after a lost response) replays instead of re-booking.
    const retry = await book()
    expect(retry.status).toBe(200)
    expect(((await retry.json()) as { appointmentId: string }).appointmentId).toBe(firstBody.appointmentId)
    // Location-scoped: this file shares one database across tests.
    const rows = await db.query<{ id: string }>('SELECT id FROM appointments WHERE location_id = $1', [loc])
    expect(rows).toHaveLength(1)
  } finally {
    await pool.end()
  }
})

test('N4/G3 on real PG: concurrent same-key bookings execute exactly once; losers replay', async () => {
  const { pool, db, loc, app } = await setup()
  try {
    const book = () =>
      app.request(`/${loc}/cash-offer/book`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'n4pg-race-1' },
        body: JSON.stringify({
          start: FIRST_SLOT,
          end: '2025-06-09T13:30:00.000Z',
          name: 'V',
          email: 'v@example.com',
        }),
      })
    // Twins racing one key: the winner books + completes; losers either see
    // the fresh claim (409, then replay) or arrive post-commit (200 replay).
    // Either interleaving is correct — exactly one booking must exist.
    const firstWave = await Promise.all([book(), book(), book(), book(), book(), book(), book(), book()])
    const ids = new Set<string>()
    for (const res of firstWave) {
      expect([200, 409]).toContain(res.status)
      if (res.status === 200) ids.add(((await res.json()) as { appointmentId: string }).appointmentId)
    }
    const retry = await book()
    expect(retry.status).toBe(200)
    ids.add(((await retry.json()) as { appointmentId: string }).appointmentId)
    expect(ids.size).toBe(1)
    const rows = await db.query<{ id: string }>('SELECT id FROM appointments WHERE location_id = $1', [loc])
    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe([...ids][0])
  } finally {
    await pool.end()
  }
})
