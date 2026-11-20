import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../app-env'
import type { Database } from '../db/database'
import type { WorkflowDispatch, WorkflowEvent } from '../jobs/workflow-dispatcher'
import { renderFormNotFound, renderFormPage } from '../lib/form-page'
import {
  IdempotencyConflict,
  IdempotencyInProgress,
  InvalidIdempotencyKey,
  completeIdempotencyKey,
  parseIdempotencyKey,
  withIdempotency,
} from '../lib/idempotency'
import { readFields } from '../lib/page-html'
import { ContactsRepo } from '../repos/contacts-repo'
import { FormSubmissionsRepo } from '../repos/form-submissions-repo'
import { FormsRepo } from '../repos/forms-repo'
import { LocationsRepo } from '../repos/locations-repo'
import { OutboxRepo } from '../repos/outbox-repo'
import { TimelineRepo } from '../repos/timeline-repo'

const submitSchema = z.object({
  values: z.record(z.string(), z.string()).default({}),
})

/**
 * Public, UNAUTHENTICATED standalone forms — mounted at `/api/public/forms`
 * BEFORE the operatorAuth boundary, so it reads the location from the URL
 * (`:loc`) itself. A form is single-page (no `:path`, no `next`), unlike a
 * funnel:
 *
 *   GET  /:loc/:slug         → a published form (visitor render)
 *   POST /:loc/:slug/submit  → capture a lead off the form
 *
 * The submit runs the same capture keystone as a funnel — upsert a contact,
 * apply the form's tag, bump the honest counter, log a timeline event, dispatch
 * `contact_created` — and ADDITIONALLY STORES the raw submission in
 * form_submissions, the capability that distinguishes a form from a funnel step
 * (which only counts). Only published forms are reachable.
 */
export function publicFormsRoute(deps: {
  db: Database
  /** Fired after a capture so live workflows enroll the new lead. */
  dispatch?: WorkflowDispatch
}): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  /** The location's branding color (for the CTA + accents), or undefined. */
  async function brandColor(loc: string): Promise<string | undefined> {
    const location = await new LocationsRepo(deps.db).getById(loc)
    const color = location?.branding.color
    return typeof color === 'string' ? color : undefined
  }

  // A published form renders as a real, hostable HTML landing page. Unpublished
  // or unknown → a styled 404 page.
  app.get('/:loc/:slug', async (c) => {
    const loc = c.req.param('loc')
    const slug = c.req.param('slug')
    const form = await new FormsRepo(deps.db, loc).getBySlug(slug)
    if (!form || form.status !== 'published') return c.html(renderFormNotFound(), 404)
    return c.html(renderFormPage(form, { brandColor: await brandColor(loc) }))
  })

  app.post('/:loc/:slug/submit', zValidator('json', submitSchema), async (c) => {
    const loc = c.req.param('loc')
    const slug = c.req.param('slug')
    const { values } = c.req.valid('json')

    const formsRepo = new FormsRepo(deps.db, loc)
    const form = await formsRepo.getBySlug(slug)
    if (!form || form.status !== 'published') return c.json({ error: 'not found' }, 404)

    // Validate every required field the form declares is present.
    for (const field of readFields(form.content)) {
      if (field.required && !values[field.name]?.trim()) {
        return c.json({ error: 'missing required field', field: field.name }, 400)
      }
    }

    // Submission identity (R14-01): an explicit Idempotency-Key makes a retry
    // one logical submission; WITHOUT a key every request executes as its own
    // logical submission. There is deliberately NO content-derived fallback —
    // payload equality must never collapse two intentional submits. API
    // contract: clients needing retry safety MUST supply a stable key.
    const capture = async (tx: Database) => {
      // Capture the lead. Known field names map onto contact identity; the full
      // raw values map is preserved on the stored submission below.
      const contactsRepo = new ContactsRepo(tx, loc)
      const { contact, created } = await contactsRepo.upsertByMatch(
        {
          name: values.full_name ?? values.name,
          email: values.email,
          phone: values.phone,
        },
        `form:${slug}`,
      )

      const tag = typeof form.content.tag === 'string' ? form.content.tag : undefined
      if (tag) await contactsRepo.addTag(contact.id, tag)

      // STORE the submission — the form's distinguishing capability. The operator
      // submissions viewer reads these raw values back per form.
      await new FormSubmissionsRepo(tx, loc).create({
        formId: form.id,
        contactId: contact.id,
        values,
      })

      await new FormsRepo(tx, loc).incrementSubmissions(form.id)
      await new TimelineRepo(tx, loc).add({
        contactId: contact.id,
        type: 'form_submission',
        refTable: 'forms',
        refId: form.id,
        payload: { form: slug },
      })

      // The new-contact automation intent commits WITH the capture under a
      // STABLE event id; the fast dispatch below fires post-commit and the
      // sweeper covers a crash between them. Redelivery converges.
      const events: WorkflowEvent[] = []
      if (created) {
        const eventId = `contact-created:${contact.id}`
        await new OutboxRepo(tx, loc).insert({
          id: eventId,
          aggregate: 'contact',
          aggregateId: contact.id,
          event: 'contact_created',
          payload: { contactId: contact.id },
        })
        events.push({ locationId: loc, triggerType: 'contact_created', contactId: contact.id, eventId })
      }
      return { out: { contactId: contact.id }, events }
    }
    try {
      const key = parseIdempotencyKey(c.req.header('Idempotency-Key'))
      const scope = { locationId: loc, operation: 'form-submit', key: key ?? '', payload: { slug, values } }
      const settled = key
        ? await withIdempotency(deps.db, scope, () =>
            deps.db.withTransaction(async (tx) => {
              const result = await capture(tx)
              await completeIdempotencyKey(tx, scope, result)
              return result
            }),
          )
        : { result: await deps.db.withTransaction(capture), reused: false }
      if (!settled.reused) {
        for (const event of settled.result.events) {
          try {
            await deps.dispatch?.(event)
          } catch {
            // Best-effort: the outbox intent committed, so the sweeper delivers
            // what this misses. Never fail the capture for a dispatch fault.
          }
        }
      }
      return c.json({ ok: true, ...settled.result.out, ...(settled.reused ? { deduped: true } : {}) })
    } catch (err) {
      if (err instanceof InvalidIdempotencyKey) {
        return c.json({ error: err.message }, 400)
      }
      if (err instanceof IdempotencyConflict || err instanceof IdempotencyInProgress) {
        return c.json({ error: err.message }, 409)
      }
      throw err
    }
  })

  return app
}
