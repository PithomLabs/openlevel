import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { Hono } from 'hono'
import type { AppEnv } from '../app-env'
import type { Database } from '../db/database'
import { PgliteDatabase } from '../db/pglite-database'
import { dispatchWorkflowEvent } from '../jobs/workflow-dispatcher'
import { AppointmentsRepo } from '../repos/appointments-repo'
import { CalendarsRepo } from '../repos/calendars-repo'
import { WorkflowActionsRepo } from '../repos/workflow-actions-repo'
import { WorkflowsRepo } from '../repos/workflows-repo'
import { publicBookingRoute } from './public-booking'

const SCHEMA = readFileSync(fileURLToPath(new URL('../../db/schema.sql', import.meta.url)), 'utf8')

// A pinned clock: Monday 2025-06-09, 04:00 in New York (EDT). The enabled
// calendar opens Mondays 9–12, so the canonical open day is "today".
const NOW = new Date('2025-06-09T08:00:00Z')
const MONDAY = '2025-06-09'
const FIRST_SLOT = '2025-06-09T13:00:00.000Z' // 9:00 AM EDT

// A booking-enabled calendar (+ a disabled one) and a LIVE appointment_booked
// workflow — so a public booking proves the whole reserve → automation loop.
async function setup() {
  const pg = new PGlite()
  await pg.exec(SCHEMA)
  const db = new PgliteDatabase(pg)
  const loc = 'loc_test'
  await db.query("INSERT INTO locations (id, name, slug) VALUES ($1,'Test','test')", [loc])

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
    bookingHeadline: 'Book your cash-offer call',
    bookingBlurb: 'Pick a time that works.',
  })

  // A calendar that has a slug but is NOT booking-enabled — must 404 publicly.
  const off = await calRepo.create({ name: 'Internal' })
  await calRepo.update(off.id, { bookingSlug: 'disabled-cal' })

  // A live workflow that tags whoever books — proves the dispatch fires.
  const wf = await new WorkflowsRepo(db, loc).create({
    name: 'Booking welcome',
    triggerType: 'appointment_booked',
  })
  await new WorkflowsRepo(db, loc).update(wf.id, { status: 'live' })
  await new WorkflowActionsRepo(db, loc).replaceAll(wf.id, [
    { type: 'add_tag', config: { tag: 'booked-welcome' } },
  ])

  const dispatch = async (e: Parameters<typeof dispatchWorkflowEvent>[1]) => {
    await dispatchWorkflowEvent({ db, waitsEnabled: true }, e)
  }
  const app = new Hono<AppEnv>()
  app.route('/', publicBookingRoute({ db, dispatch, now: () => NOW }))
  return { db, loc, app, calId: cal.id }
}

test('GET /:loc/:slug renders the booking page as a hostable html document', async () => {
  const { app } = await setup()
  const res = await app.request('/loc_test/cash-offer')

  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toContain('text/html')
  const html = await res.text()
  expect(html).toContain('<!doctype html>')
  expect(html).toContain('Book your cash-offer call')
  expect(html).toContain('Mon, Jun 9') // a bookable date pill
  expect(html).toContain('/api/public/booking/loc_test/cash-offer') // wired endpoints
})

test('GET /:loc/:slug is a styled 404 for an unknown slug', async () => {
  const { app } = await setup()
  const res = await app.request('/loc_test/nope')
  expect(res.status).toBe(404)
  expect((await res.text()).toLowerCase()).toContain('unavailable')
})

test('GET /:loc/:slug is 404 for a calendar that is not booking-enabled', async () => {
  const { app } = await setup()
  const res = await app.request('/loc_test/disabled-cal')
  expect(res.status).toBe(404)
})

test('GET slots returns the open times for the Monday and nothing on a closed day', async () => {
  const { app } = await setup()

  const mon = (await (await app.request(`/loc_test/cash-offer/slots?date=${MONDAY}`)).json()) as {
    slots: { start: string; label: string }[]
  }
  expect(mon.slots).toHaveLength(6) // 9:00 … 11:30, every 30 min
  expect(mon.slots[0]?.start).toBe(FIRST_SLOT)
  expect(mon.slots[0]?.label).toBe('9:00 AM')

  const sun = (await (await app.request('/loc_test/cash-offer/slots?date=2025-06-08')).json()) as {
    slots: unknown[]
  }
  expect(sun.slots).toHaveLength(0) // Sunday has no window
})

test('GET slots excludes a time the calendar is already booked for', async () => {
  const { app, db, loc, calId } = await setup()
  await new AppointmentsRepo(db, loc).create({
    calendarId: calId,
    title: 'Existing',
    startsAt: FIRST_SLOT,
    endsAt: '2025-06-09T13:30:00.000Z',
  })

  const mon = (await (await app.request(`/loc_test/cash-offer/slots?date=${MONDAY}`)).json()) as {
    slots: { start: string }[]
  }
  expect(mon.slots).toHaveLength(5)
  expect(mon.slots.some((s) => s.start === FIRST_SLOT)).toBe(false)
})

test('POST book reserves the slot: creates a contact + appointment, logs it, runs the live workflow', async () => {
  const { app, db, loc, calId } = await setup()

  const res = await app.request('/loc_test/cash-offer/book', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      start: FIRST_SLOT,
      end: '2025-06-09T13:30:00.000Z',
      name: 'Olivia Reed',
      email: 'olivia@example.com',
      phone: '+15125550148',
      notes: 'Looking forward to it',
    }),
  })

  expect(res.status).toBe(200)
  const body = (await res.json()) as { ok: boolean; appointmentId: string; contactId: string }
  expect(body.ok).toBe(true)
  expect(body.appointmentId).toBeTruthy()

  // The appointment exists on the right calendar, at the chosen instant.
  const [appt] = await db.query<{ calendar_id: string; starts_at: string; contact_id: string }>(
    'SELECT calendar_id, starts_at, contact_id FROM appointments WHERE id=$1',
    [body.appointmentId],
  )
  expect(appt?.calendar_id).toBe(calId)
  expect(new Date(appt?.starts_at ?? 0).toISOString()).toBe(FIRST_SLOT)
  expect(appt?.contact_id).toBe(body.contactId)

  // A real contact was captured AND the live appointment_booked workflow tagged it.
  const [contact] = await db.query<{ name: string; tags: string[]; source: string }>(
    'SELECT name, tags, source FROM contacts WHERE id=$1',
    [body.contactId],
  )
  expect(contact?.name).toBe('Olivia Reed')
  expect(contact?.source).toBe('booking:cash-offer')
  expect(contact?.tags).toContain('booked-welcome') // workflow ran end-to-end

  // The booking was logged to the contact's timeline.
  const timeline = await db.query<{ type: string }>(
    'SELECT type FROM timeline_events WHERE contact_id=$1',
    [body.contactId],
  )
  expect(timeline.some((t) => t.type === 'appointment_booked')).toBe(true)
})

test('POST book is 409 when the slot was taken in the meantime (double-book guard)', async () => {
  const { app } = await setup()
  const book = (email: string) =>
    app.request('/loc_test/cash-offer/book', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        start: FIRST_SLOT,
        end: '2025-06-09T13:30:00.000Z',
        name: 'Visitor',
        email,
      }),
    })

  expect((await book('first@example.com')).status).toBe(200)
  // A DIFFERENT visitor (different idempotency identity) meets the guard.
  const second = await book('second@example.com')
  expect(second.status).toBe(409)
  expect((await second.json()).error).toBe('slot taken')
})

test('POST book retry-after-success replays instead of double-booking (FIND-09)', async () => {
  const { app, db } = await setup()
  const book = () =>
    app.request('/loc_test/cash-offer/book', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        start: FIRST_SLOT,
        end: '2025-06-09T13:30:00.000Z',
        name: 'Olivia Reed',
        email: 'olivia@example.com',
      }),
    })

  const first = await book()
  expect(first.status).toBe(200)
  const firstBody = (await first.json()) as { appointmentId: string; contactId: string }
  const retry = await book()
  expect(retry.status).toBe(200)
  // Same recorded result, honestly flagged as a replay.
  expect(await retry.json()).toMatchObject({
    ok: true,
    appointmentId: firstBody.appointmentId,
    contactId: firstBody.contactId,
    deduped: true,
  })
  // Exactly one of everything — no duplicate writes on replay.
  const counts = await db.query<{ n: number }>(
    'SELECT (SELECT count(*) FROM appointments)::int + (SELECT count(*) FROM timeline_events)::int + (SELECT count(*) FROM outbox)::int AS n',
  )
  expect(counts[0]?.n).toBe(3)
})

test('POST book honors an explicit Idempotency-Key and conflicts on reuse (FIND-09)', async () => {
  const { app } = await setup()
  const book = (headers: Record<string, string>, email: string) =>
    app.request('/loc_test/cash-offer/book', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ start: FIRST_SLOT, end: '2025-06-09T13:30:00.000Z', name: 'N', email }),
    })

  const first = await book({ 'Idempotency-Key': 'key-1' }, 'a@example.com')
  expect(first.status).toBe(200)
  const replay = await book({ 'Idempotency-Key': 'key-1' }, 'a@example.com')
  expect(replay.status).toBe(200)
  expect(await replay.json()).toMatchObject({ deduped: true })
  // Same key, different payload: conflict, never silent reuse.
  const clash = await book({ 'Idempotency-Key': 'key-1' }, 'b@example.com')
  expect(clash.status).toBe(409)
  expect(await clash.json()).toMatchObject({ error: expect.stringMatching(/different .* payload/) })
})

test('POST book writes an outbox row whose id doubles as the dispatch event id (FIND-09)', async () => {
  const { app, db } = await setup()
  const res = await app.request('/loc_test/cash-offer/book', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      start: FIRST_SLOT,
      end: '2025-06-09T13:30:00.000Z',
      name: 'Olivia Reed',
      email: 'olivia@example.com',
    }),
  })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { appointmentId: string; contactId: string }
  const rows = await db.query<{ id: string; status: string; event: string }>(
    'SELECT id, status, event FROM outbox',
  )
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ id: `booking:${body.appointmentId}`, status: 'pending', event: 'appointment_booked' })
  // The fast-path dispatch fired with that same stable id (visible via the claim).
  const claims = await db.query<{ event_id: string }>('SELECT event_id FROM processed_events')
  expect(claims.map((r) => r.event_id)).toContain(`booking:${body.appointmentId}`)
})

/**
 * Fails the first query matching `pattern`, then behaves. Proves atomicity.
 * Counter is shared across the transaction view so faults trigger inside the
 * unit under test, not just around it.
 */
class FlakyDb implements Database {
  constructor(
    private inner: Database,
    private pattern: RegExp,
    private state = { left: 1 },
  ) {}
  async query<T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> {
    if (this.state.left > 0 && this.pattern.test(sql)) {
      this.state.left -= 1
      throw new Error('injected fault')
    }
    return this.inner.query<T>(sql, params)
  }
  withTransaction<T>(fn: (db: Database) => Promise<T>): Promise<T> {
    return this.inner.withTransaction((tx) => fn(new FlakyDb(tx, this.pattern, this.state)))
  }
}

test.each([
  ['contact write', /INSERT INTO contacts/],
  ['appointment write', /INSERT INTO appointments/],
  ['timeline write', /INSERT INTO timeline_events/],
  ['outbox write', /INSERT INTO outbox/],
])('POST book fault at %s rolls everything back and releases the key (FIND-09)', async (_label, pattern) => {
  const { db, app: _ignored } = await setup()
  const flaky = new FlakyDb(db, pattern)
  const app = new Hono<AppEnv>()
  app.route(
    '/',
    publicBookingRoute({
      db: flaky,
      dispatch: async (e) => {
        await dispatchWorkflowEvent({ db, waitsEnabled: true }, e)
      },
      now: () => NOW,
    }),
  )
  const book = () =>
    app.request('/loc_test/cash-offer/book', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        start: FIRST_SLOT,
        end: '2025-06-09T13:30:00.000Z',
        name: 'Olivia Reed',
        email: 'olivia@example.com',
      }),
    })

  const res = await book()
  expect(res.status).toBe(500)
  // Nothing committed anywhere: no contact, no appointment, no timeline, no outbox.
  const counts = await db.query<{ n: number }>(
    'SELECT (SELECT count(*) FROM contacts)::int + (SELECT count(*) FROM appointments)::int + (SELECT count(*) FROM timeline_events)::int + (SELECT count(*) FROM outbox)::int AS n',
  )
  expect(counts[0]?.n).toBe(0)
  // The key was released: the retry (fault spent) books cleanly.
  const retry = await book()
  expect(retry.status).toBe(200)
})

/**
 * N4: faults the completion UPDATE only when issued OUTSIDE a transaction.
 * The booking transaction itself is unfaulted — so the request succeeds if
 * and only if idempotency completion commits atomically with the booking.
 */
class OuterFaultDb implements Database {
  constructor(
    private inner: Database,
    private pattern: RegExp,
    private state = { left: 1 },
  ) {}
  async query<T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> {
    if (this.state.left > 0 && this.pattern.test(sql)) {
      this.state.left -= 1
      throw new Error('injected post-commit fault')
    }
    return this.inner.query<T>(sql, params)
  }
  withTransaction<T>(fn: (db: Database) => Promise<T>): Promise<T> {
    return this.inner.withTransaction(fn)
  }
}

test('N4: booking completion is atomic with the booking — a post-commit crash cannot wedge the key', async () => {
  const { db, app: _ignored } = await setup()
  const faulted = new OuterFaultDb(db, /UPDATE idempotency_keys SET status = 'completed'/)
  const app = new Hono<AppEnv>()
  app.route(
    '/',
    publicBookingRoute({
      db: faulted,
      dispatch: async (e) => {
        await dispatchWorkflowEvent({ db, waitsEnabled: true }, e)
      },
      now: () => NOW,
    }),
  )
  const book = () =>
    app.request('/loc_test/cash-offer/book', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'n4probe-key-1' },
      body: JSON.stringify({
        start: FIRST_SLOT,
        end: '2025-06-09T13:30:00.000Z',
        name: 'Olivia Reed',
        email: 'olivia@example.com',
      }),
    })

  // The completion UPDATE never escapes the transaction, so the injected
  // post-commit fault cannot fire: the booking succeeds despite it.
  const res = await book()
  expect(res.status).toBe(200)
  const body = (await res.json()) as { appointmentId: string }
  // Same-key retry replays the original result; no second booking exists.
  const retry = await book()
  expect(retry.status).toBe(200)
  expect(((await retry.json()) as { appointmentId: string }).appointmentId).toBe(body.appointmentId)
  const counts = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM appointments')
  expect(counts[0]?.n).toBe(1)
  const keys = await db.query<{ status: string; result: unknown }>(
    `SELECT status, result FROM idempotency_keys WHERE key = 'n4probe-key-1'`,
  )
  expect(keys[0]?.status).toBe('completed')
  expect(keys[0]?.result).toMatchObject({ appointmentId: body.appointmentId })
})

test('the appointments schema forbids two live bookings at the same calendar instant', async () => {
  const { db, loc, calId } = await setup()
  const repo = new AppointmentsRepo(db, loc)
  await repo.create({
    calendarId: calId,
    title: 'First',
    startsAt: FIRST_SLOT,
    endsAt: '2025-06-09T13:30:00.000Z',
  })
  // A second LIVE appointment at the exact same calendar+instant must be refused
  // at the DATABASE, not merely by the slot snapshot the route happens to read —
  // that is what makes the booking race un-winnable rather than merely unlikely.
  await expect(
    repo.create({
      calendarId: calId,
      title: 'Second',
      startsAt: FIRST_SLOT,
      endsAt: '2025-06-09T13:30:00.000Z',
    }),
  ).rejects.toThrow()
})

test('POST book survives a concurrent double-book: exactly one 200, one 409, one row', async () => {
  const { app, db } = await setup()
  const book = (name: string, email: string) =>
    app.request('/loc_test/cash-offer/book', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ start: FIRST_SLOT, end: '2025-06-09T13:30:00.000Z', name, email }),
    })

  // Two visitors fire for the SAME slot in the same tick. Both pass the slot
  // snapshot (neither has written yet); the DB invariant must let only one land
  // and the loser must get an honest 409, never a 500.
  const [a, b] = await Promise.all([
    book('Ava Stone', 'ava@example.com'),
    book('Ben Cole', 'ben@example.com'),
  ])
  expect([a.status, b.status].sort()).toEqual([200, 409])

  const rows = await db.query<{ id: string }>(
    "SELECT id FROM appointments WHERE starts_at=$1 AND status <> 'cancelled'",
    [FIRST_SLOT],
  )
  expect(rows).toHaveLength(1)
})

test('POST book is 409 for a start time that was never offered', async () => {
  const { app } = await setup()
  const res = await app.request('/loc_test/cash-offer/book', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      start: '2025-06-09T20:00:00.000Z', // 4:00 PM EDT — outside the 9–12 window
      end: '2025-06-09T20:30:00.000Z',
      name: 'Off Hours',
      email: 'off@example.com',
    }),
  })
  expect(res.status).toBe(409)
})

test('POST book is 404 for a calendar that is not booking-enabled', async () => {
  const { app } = await setup()
  const res = await app.request('/loc_test/disabled-cal/book', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      start: FIRST_SLOT,
      end: '2025-06-09T13:30:00.000Z',
      name: 'Nope',
      email: 'nope@example.com',
    }),
  })
  expect(res.status).toBe(404)
})
