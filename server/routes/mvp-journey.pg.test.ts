/**
 * MVP end-to-end journey (§14) on real disposable PostgreSQL: a business
 * owner watches one lead travel capture → contact → timeline → visibility →
 * booking, with retries, contention, honest refusals, and staging fences.
 *
 * Twelve acceptance points in narrative order (numbered in comments). Focused
 * suites prove each invariant in isolation; this file proves they hold
 * TOGETHER through the real HTTP surface (createApp, no route stubs).
 */
import { readFileSync } from 'node:fs'
import { inject } from 'vitest'
import { Pool } from 'pg'
import { createApp } from '../index'
import { PgDatabase } from '../db/database'
import { dispatchWorkflowEvent } from '../jobs/workflow-dispatcher'
import { createSession } from '../lib/session'
import { CalendarsRepo } from '../repos/calendars-repo'
import { CampaignsRepo } from '../repos/campaigns-repo'
import { FormsRepo } from '../repos/forms-repo'
import { WorkflowActionsRepo } from '../repos/workflow-actions-repo'
import { WorkflowsRepo } from '../repos/workflows-repo'

const baseUrl: string = inject('pgTestUrl') ?? process.env.OPENLEVEL_PG_TEST_URL ?? ''
if (baseUrl === '') throw new Error('pgTestUrl not provided — run via task test:pg')

const SCHEMA = readFileSync(new URL('../../db/schema.sql', import.meta.url), 'utf8')
const SESSION_SECRET = 'journey-session-secret-fake-0000000000'

beforeAll(async () => {
  const pool = new Pool({ connectionString: baseUrl })
  try {
    await pool.query(SCHEMA)
  } finally {
    await pool.end()
  }
})

function ymdIn(days: number): string {
  const d = new Date(Date.now() + days * 86400000)
  return d.toISOString().slice(0, 10)
}

async function setup() {
  const pool = new Pool({ connectionString: baseUrl, max: 4 })
  const db = new PgDatabase(pool)
  const loc = `journey_${process.pid}_${Math.floor(Math.random() * 1e9)}`
  await db.query(`INSERT INTO locations (id, name, slug) VALUES ($1, 'Journey Co', $1)`, [loc])

  // Operators: one owner, one member.
  await db.query(
    `INSERT INTO operators (id, email, role, password_hash) VALUES
     ('${loc}-owner', 'owner@example.com', 'owner', 'x'),
     ('${loc}-member', 'member@example.com', 'member', 'x')`,
  )
  await db.query(`INSERT INTO operator_locations (operator_id, location_id) VALUES ('${loc}-owner', $1), ('${loc}-member', $1)`, [loc])
  const ownerToken = createSession({ operatorId: `${loc}-owner` }, SESSION_SECRET)
  const memberToken = createSession({ operatorId: `${loc}-member` }, SESSION_SECRET)

  // A published lead form + a live welcome workflow (tags new contacts).
  await new FormsRepo(db, loc).create({
    name: 'Cash offer request',
    slug: 'cash-offer',
    status: 'published',
    content: {
      tag: 'lead',
      fields: [
        { name: 'full_name', label: 'Full name', type: 'text', required: true },
        { name: 'email', label: 'Email', type: 'email', required: false },
        { name: 'phone', label: 'Phone', type: 'tel', required: true },
      ],
    },
  })
  const wf = await new WorkflowsRepo(db, loc).create({ name: 'New lead welcome', triggerType: 'contact_created' })
  await new WorkflowsRepo(db, loc).update(wf.id, { status: 'live' })
  await new WorkflowActionsRepo(db, loc).replaceAll(wf.id, [{ type: 'add_tag', config: { tag: 'welcomed' } }])

  // A bookable calendar, open all week so the real clock always finds slots.
  const cal = await new CalendarsRepo(db, loc).create({ name: 'Consultations' })
  await new CalendarsRepo(db, loc).update(cal.id, {
    bookingEnabled: true,
    bookingSlug: 'consult',
    timezone: 'America/New_York',
    durationMin: 30,
    slotIntervalMin: 0,
    bufferMin: 0,
    noticeMin: 0,
    rollingDays: 14,
    availability: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start: '00:00', end: '23:30' })),
  })

  const app = createApp({
    db,
    sessionSecret: SESSION_SECRET,
    webhookSecret: 'journey-webhook-secret-fake-00000000',
    dispatch: async (e) => {
      await dispatchWorkflowEvent({ db, waitsEnabled: false }, e)
    },
  })
  return { pool, db, loc, app, ownerToken, memberToken }
}

test('MVP journey: capture → contact → timeline → operator view → booking, retries, contention, honesty, fences', async () => {
  const { pool, db, loc, app, ownerToken, memberToken } = await setup()
  try {
    const bearer = (t: string) => ({ authorization: `Bearer ${t}` })
    const submitLead = (over: Record<string, string> = {}) =>
      app.request(`/api/public/forms/${loc}/cash-offer/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: { full_name: 'Olivia Reed', email: 'olivia@example.com', phone: '+15125550148', ...over } }),
      })

    // (1) Public lead capture works.
    const captured = await submitLead()
    expect(captured.status).toBe(200)
    const { contactId } = (await captured.json()) as { contactId: string }

    // (2/3) Upsert is correct: a repeat submit resolves to the SAME contact.
    const repeat = await submitLead()
    expect(repeat.status).toBe(200)
    expect(((await repeat.json()) as { contactId: string }).contactId).toBe(contactId)
    const contacts = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM contacts WHERE location_id = $1', [loc])
    expect(contacts[0]?.n).toBe(1)

    // (4/5) Timeline corresponds to real operations; the operator sees it.
    const detail = await app.request(`/api/loc/${loc}/contacts/${contactId}`, { headers: bearer(ownerToken) })
    expect(detail.status).toBe(200)
    const body = (await detail.json()) as { contact: { tags: string[] }; timeline: { type: string }[] }
    expect(body.contact.tags).toEqual(expect.arrayContaining(['lead', 'welcomed']))
    expect(body.timeline.map((t) => t.type)).toContain('form_submission')

    // (6) Authorization is enforced: 401 unauthenticated, 403 non-owner.
    expect((await app.request(`/api/loc/${loc}/contacts/${contactId}`)).status).toBe(401)
    expect((await app.request('/api/locations', { headers: bearer(memberToken) })).status).toBe(403)
    expect((await app.request('/api/locations', { headers: bearer(ownerToken) })).status).toBe(200)

    // (7/8) Booking commits atomically with timeline + outbox correspondence.
    const date = ymdIn(3)
    const slotsRes = await app.request(`/api/public/booking/${loc}/consult/slots?date=${date}`)
    const slots = ((await slotsRes.json()) as { slots: { start: string; end: string }[] }).slots
    expect(slots.length).toBeGreaterThan(1)
    const slot = slots[0]!
    const book = (extra: Record<string, string> = {}, key = 'journey-key-1') =>
      app.request(`/api/public/booking/${loc}/consult/book`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
        body: JSON.stringify({ start: slot.start, end: slot.end, name: 'Olivia Reed', email: 'olivia@example.com', ...extra }),
      })
    const booked = await book()
    expect(booked.status).toBe(200)
    const { appointmentId } = (await booked.json()) as { appointmentId: string }
    const bookedEvents = await db.query<{ type: string }>(
      'SELECT type FROM timeline_events WHERE location_id = $1 AND ref_id = $2',
      [loc, appointmentId],
    )
    expect(bookedEvents.map((r) => r.type)).toContain('appointment_booked')
    const outbox = await db.query<{ id: string }>(
      "SELECT id FROM outbox WHERE location_id = $1 AND aggregate = 'appointment' AND aggregate_id = $2",
      [loc, appointmentId],
    )
    expect(outbox).toHaveLength(1)

    // (9) Same-key retry replays the original result; no second booking.
    const replayed = await book()
    expect(replayed.status).toBe(200)
    expect(((await replayed.json()) as { appointmentId: string }).appointmentId).toBe(appointmentId)
    const appts = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM appointments WHERE location_id = $1', [loc])
    expect(appts[0]?.n).toBe(1)

    // (10) Contention behaves: same slot, another visitor → honest 409.
    const rival = await book({ name: 'Rival Person', email: 'rival@example.com', phone: '+15125550199' }, 'journey-key-2')
    expect(rival.status).toBe(409)

    // (11) No misleading messaging state: an unconnected campaign refuses honestly.
    const campaign = await new CampaignsRepo(db, loc).create({ name: 'Blast', channel: 'sms', body: 'Hi!', audienceTag: null })
    const sendAttempt = await app.request(`/api/loc/${loc}/campaigns/${campaign.id}/send`, {
      method: 'POST',
      headers: { ...bearer(ownerToken), 'Idempotency-Key': 'journey-camp-1' },
    })
    expect(sendAttempt.status).toBe(409)
    expect(await sendAttempt.text()).toMatch(/no sms provider connected/)
    const campRow = await db.query<{ status: string }>('SELECT status FROM campaigns WHERE id = $1', [campaign.id])
    expect(campRow[0]?.status).not.toBe('sent')

    // (12) Staging protections enforced end to end: a send under the staging
    // fence is simulated (sink), honestly labeled, nothing delivered. A fresh
    // campaign: the refused one above stays claim-guarded, as designed.
    const staged = await new CampaignsRepo(db, loc).create({ name: 'Staged', channel: 'sms', body: 'Hi!', audienceTag: null })
    const savedEnv = { APP_ENV: process.env.APP_ENV, ALLOW: process.env.STAGING_SINK_ALLOWLIST }
    try {
      process.env.APP_ENV = 'staging'
      process.env.STAGING_SINK_ALLOWLIST = 'olivia@example.com,+15125550148'
      const fenced = await app.request(`/api/loc/${loc}/campaigns/${staged.id}/send`, {
        method: 'POST',
        headers: { ...bearer(ownerToken), 'Idempotency-Key': 'journey-camp-2' },
      })
      expect(fenced.status).toBe(200)
      const fencedBody = (await fenced.json()) as { simulated: boolean; delivery: { sent: number; simulated: number } }
      expect(fencedBody.simulated).toBe(true)
      // R13-07: sink writes count as simulated; sent (real delivery) stays 0.
      expect(fencedBody.delivery.sent).toBe(0)
      const sunk = await db.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM outbound_sink WHERE location_id = $1 AND channel = 'sms'",
        [loc],
      )
      expect(sunk[0]?.n).toBe(fencedBody.delivery.simulated)
      expect(sunk[0]?.n).toBeGreaterThan(0)
    } finally {
      if (savedEnv.APP_ENV === undefined) delete process.env.APP_ENV
      else process.env.APP_ENV = savedEnv.APP_ENV
      if (savedEnv.ALLOW === undefined) delete process.env.STAGING_SINK_ALLOWLIST
      else process.env.STAGING_SINK_ALLOWLIST = savedEnv.ALLOW
    }
  } finally {
    await pool.end()
  }
}, 120000)
