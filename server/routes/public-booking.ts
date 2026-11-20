import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../app-env'
import type { Database } from '../db/database'
import type { WorkflowDispatch } from '../jobs/workflow-dispatcher'
import { bookableDates, parseYmd, slotsForDate, zonedYmd } from '../lib/availability'
import { calendarBusyFor, toConfig } from '../lib/booking-availability'
import { renderBookingNotFound, renderBookingPage } from '../lib/booking-page'
import { isUniqueViolation } from '../lib/db-errors'
import {
  IdempotencyConflict,
  IdempotencyInProgress,
  completeIdempotencyKey,
  withIdempotency,
} from '../lib/idempotency'
import { AppointmentsRepo } from '../repos/appointments-repo'
import { type Calendar, CalendarsRepo } from '../repos/calendars-repo'
import { ContactsRepo } from '../repos/contacts-repo'
import { LocationsRepo } from '../repos/locations-repo'
import { OutboxRepo } from '../repos/outbox-repo'
import { TimelineRepo } from '../repos/timeline-repo'

const bookSchema = z.object({
  start: z.string().datetime(),
  end: z.string().datetime(),
  name: z.string().trim().min(1),
  email: z.string().trim().email(),
  phone: z.string().trim().optional().nullable(),
  notes: z.string().trim().optional().nullable(),
})

/**
 * Public, UNAUTHENTICATED booking pages — mounted at `/api/public/booking`
 * BEFORE the operatorAuth boundary, so the location comes from the URL (`:loc`).
 * A calendar is reachable here only while it is `booking_enabled`:
 *
 *   GET  /:loc/:slug              → the hosted booking page (visitor render)
 *   GET  /:loc/:slug/slots?date=  → open times for one local date (JSON)
 *   POST /:loc/:slug/book         → reserve a slot (creates contact + appointment)
 *
 * The slot math lives in lib/availability and is recomputed on every request, so
 * the page can never offer — or accept — a time that the calendar's own
 * appointments, notice window, or buffer have since closed. Booking dispatches
 * `appointment_booked`, closing the capture → automation loop.
 */
/** Lost the appointment write race: maps to an honest 409 after rollback. */
export class SlotTaken extends Error {
  constructor() {
    super('slot taken')
    this.name = 'SlotTaken'
  }
}

export function publicBookingRoute(deps: {
  db: Database
  /** Fired after a booking so live `appointment_booked` workflows enroll the lead. */
  dispatch?: WorkflowDispatch
  /** Injectable clock — defaults to wall-clock; tests pin it for determinism. */
  now?: () => Date
}): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  const clock = () => deps.now?.() ?? new Date()

  /** Load a booking-enabled calendar by slug, or undefined. */
  async function enabledCalendar(loc: string, slug: string): Promise<Calendar | undefined> {
    const cal = await new CalendarsRepo(deps.db, loc).getByBookingSlug(slug)
    return cal && cal.booking_enabled ? cal : undefined
  }

  /** The location's branding color, or undefined. */
  async function brandColor(loc: string): Promise<string | undefined> {
    const location = await new LocationsRepo(deps.db).getById(loc)
    const color = location?.branding.color
    return typeof color === 'string' ? color : undefined
  }

  // The hosted booking page. Unknown or not-enabled → a styled 404.
  app.get('/:loc/:slug', async (c) => {
    const loc = c.req.param('loc')
    const slug = c.req.param('slug')
    const cal = await enabledCalendar(loc, slug)
    if (!cal) return c.html(renderBookingNotFound(), 404)
    const dates = bookableDates(toConfig(cal), clock())
    return c.html(
      renderBookingPage(cal, {
        actionBase: `/api/public/booking/${loc}/${slug}`,
        dates,
        brandColor: await brandColor(loc),
      }),
    )
  })

  // Open times for one local date — the source of truth (busy + notice + buffer).
  app.get('/:loc/:slug/slots', async (c) => {
    const loc = c.req.param('loc')
    const slug = c.req.param('slug')
    const date = c.req.query('date') ?? ''
    const cal = await enabledCalendar(loc, slug)
    if (!cal) return c.json({ error: 'not found' }, 404)
    try {
      parseYmd(date)
    } catch {
      return c.json({ slots: [] })
    }
    const config = toConfig(cal)
    const busy = await calendarBusyFor(deps.db, loc, cal, date)
    return c.json({ slots: slotsForDate(config, date, busy, clock()) })
  })

  // Reserve a slot (FIND-09: atomic + idempotent). The calendar lookup runs
  // first (404s never touch idempotency state); then one idempotent unit
  // rechecks the slot snapshot, commits contact + appointment + timeline +
  // outbox row together, and the fast-path dispatch fires after commit using
  // the outbox row's stable id — so the sweeper's redelivery converges on
  // the same event_id instead of doubling. The snapshot lives INSIDE the
  // idempotent unit deliberately: a retry-after-success must replay the
  // recorded booking, not bounce off its own held slot with a 409.
  app.post('/:loc/:slug/book', zValidator('json', bookSchema), async (c) => {
    const loc = c.req.param('loc')
    const slug = c.req.param('slug')
    const input = c.req.valid('json')
    const cal = await enabledCalendar(loc, slug)
    if (!cal) return c.json({ error: 'not found' }, 404)

    // Idempotency key: explicit header wins; otherwise a stable content key
    // (same visitor retrying the same slot replays instead of double-booking).
    // Keyed on the client-provided start: match.start always equals input.start
    // on every non-409 path, so this is identical to keying on the snapshot.
    // created is intentionally ignored inside: a booking always fires
    // appointment_booked (the journey event), never contact_created — firing
    // both would double-trigger automations for direct bookers.
    const email = input.email.trim().toLowerCase()
    const key = c.req.header('Idempotency-Key') ?? `booking:${slug}:${input.start}:${email}`
    const scope = {
      locationId: loc,
      operation: 'booking-create',
      key,
      payload: { slug, start: input.start, email },
    }
    try {
      const { result, reused } = await withIdempotency(
        deps.db,
        scope,
        () =>
          deps.db.withTransaction(async (tx) => {
            const config = toConfig(cal)
            const ymd = zonedYmd(new Date(input.start), config.timezone)
            const busy = await calendarBusyFor(tx, loc, cal, ymd)
            const match = slotsForDate(config, ymd, busy, clock()).find((s) => s.start === input.start)
            if (!match) throw new SlotTaken()
            const phone = input.phone?.trim() || undefined
            const { contact } = await new ContactsRepo(tx, loc).upsertByMatch(
              { name: input.name, email: input.email, phone },
              `booking:${slug}`,
            )
            let appointment: Awaited<ReturnType<AppointmentsRepo['create']>>
            try {
              appointment = await new AppointmentsRepo(tx, loc).create({
                calendarId: cal.id,
                title: `${cal.name} — ${input.name}`,
                startsAt: match.start,
                endsAt: match.end,
                contactId: contact.id,
                notes: input.notes?.trim() || null,
              })
            } catch (err) {
              // We lost the write race: between our slot snapshot above and this
              // INSERT, another visitor claimed the same calendar+instant. The
              // partial unique index turns that into a 23505, which is an honest
              // "slot taken" — never a 500, and never a silent double-book. Any
              // other error is a real fault. Throwing rolls the transaction back.
              if (isUniqueViolation(err)) throw new SlotTaken()
              throw err
            }
            await new TimelineRepo(tx, loc).add({
              contactId: contact.id,
              type: 'appointment_booked',
              refTable: 'appointments',
              refId: appointment.id,
              payload: { calendar: cal.name, start: match.start },
            })
            await new OutboxRepo(tx, loc).insert({
              id: `booking:${appointment.id}`,
              aggregate: 'appointment',
              aggregateId: appointment.id,
              event: 'appointment_booked',
              payload: { contactId: contact.id },
            })
            const result = { appointmentId: appointment.id, contactId: contact.id }
            // N4: completion commits WITH the booking — a crash after commit
            // can never leave the key behind the business state.
            await completeIdempotencyKey(tx, scope, result)
            return result
          }),
      )
      if (!reused) {
        // Fast path; the sweeper covers a crash here via the outbox row above.
        // Skipped on replay: the original attempt already dispatched (or the
        // sweeper will), and re-firing would be deduped anyway.
        await deps.dispatch?.({
          locationId: loc,
          triggerType: 'appointment_booked',
          contactId: result.contactId,
          eventId: `booking:${result.appointmentId}`,
        })
      }
      return c.json({ ok: true, ...result, ...(reused ? { deduped: true } : {}) })
    } catch (err) {
      if (err instanceof SlotTaken) return c.json({ error: 'slot taken' }, 409)
      if (err instanceof IdempotencyConflict || err instanceof IdempotencyInProgress) {
        return c.json({ error: err.message }, 409)
      }
      throw err
    }
  })

  return app
}
