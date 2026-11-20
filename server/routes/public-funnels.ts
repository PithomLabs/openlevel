import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../app-env'
import type { Database } from '../db/database'
import { renderFunnelNotFound, renderFunnelPage } from '../lib/funnel-page'
import {
  IdempotencyConflict,
  IdempotencyInProgress,
  InvalidIdempotencyKey,
  completeIdempotencyKey,
  parseIdempotencyKey,
  withIdempotency,
} from '../lib/idempotency'
import type { WorkflowDispatch, WorkflowEvent } from '../jobs/workflow-dispatcher'
import { ContactsRepo } from '../repos/contacts-repo'
import { FunnelStepsRepo } from '../repos/funnel-steps-repo'
import { FunnelsRepo } from '../repos/funnels-repo'
import { LocationsRepo } from '../repos/locations-repo'
import { OutboxRepo } from '../repos/outbox-repo'
import { TimelineRepo } from '../repos/timeline-repo'

const submitSchema = z.object({
  values: z.record(z.string(), z.string()).default({}),
})

interface FormField {
  name: string
  label?: string
  type?: string
  required?: boolean
}

/** Read the declared form fields off a page's structured content (jsonb). */
function readFields(content: Record<string, unknown>): FormField[] {
  const f = (content as { fields?: unknown }).fields
  return Array.isArray(f) ? (f as FormField[]) : []
}

/**
 * Public, UNAUTHENTICATED funnel pages — the only unauthenticated write in the
 * app, kept deliberately narrow. Mounted at `/api/public/f` BEFORE the
 * operatorAuth boundary, so it must read the location from the URL (`:loc`)
 * itself rather than from middleware context.
 *
 *   GET  /:loc/:slug              → a published funnel + its steps (visitor render)
 *   POST /:loc/:slug/:path/submit → capture a lead off the opt-in page
 *
 * A submit is the architectural keystone: it upserts a contact, applies the
 * page's tag, bumps the honest submission counter, logs a timeline event, and
 * dispatches a `contact_created` event — so a funnel opt-in runs the live
 * welcome workflow end-to-end. Only published funnels are reachable.
 */
export function publicFunnelsRoute(deps: {
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

  // A published funnel renders as a real, hostable HTML landing page:
  //   /:loc/:slug        → its first step (the entry page)
  //   /:loc/:slug/:path  → a specific step (where the opt-in form advances to)
  // Unpublished or unknown → a styled 404 page. This is the "future hosting"
  // the Slice 8 design deferred — it makes a published funnel actually viewable.
  app.get('/:loc/:slug', async (c) => {
    const loc = c.req.param('loc')
    const slug = c.req.param('slug')
    const funnel = await new FunnelsRepo(deps.db, loc).getBySlug(slug)
    if (!funnel || funnel.status !== 'published') return c.html(renderFunnelNotFound(), 404)
    const steps = await new FunnelStepsRepo(deps.db, loc).listByFunnel(funnel.id)
    const first = steps[0]
    if (!first) return c.html(renderFunnelNotFound(), 404)
    return c.html(renderFunnelPage(funnel, first, steps, { brandColor: await brandColor(loc) }))
  })

  app.get('/:loc/:slug/:path', async (c) => {
    const loc = c.req.param('loc')
    const slug = c.req.param('slug')
    const path = c.req.param('path')
    const funnel = await new FunnelsRepo(deps.db, loc).getBySlug(slug)
    if (!funnel || funnel.status !== 'published') return c.html(renderFunnelNotFound(), 404)
    const steps = await new FunnelStepsRepo(deps.db, loc).listByFunnel(funnel.id)
    const step = steps.find((s) => s.path === path)
    if (!step) return c.html(renderFunnelNotFound(), 404)
    return c.html(renderFunnelPage(funnel, step, steps, { brandColor: await brandColor(loc) }))
  })

  app.post('/:loc/:slug/:path/submit', zValidator('json', submitSchema), async (c) => {
    const loc = c.req.param('loc')
    const slug = c.req.param('slug')
    const path = c.req.param('path')
    const { values } = c.req.valid('json')

    const funnel = await new FunnelsRepo(deps.db, loc).getBySlug(slug)
    if (!funnel || funnel.status !== 'published') return c.json({ error: 'not found' }, 404)

    const stepsRepo = new FunnelStepsRepo(deps.db, loc)
    const step = await stepsRepo.getByPath(funnel.id, path)
    if (!step) return c.json({ error: 'not found' }, 404)

    // Validate every required field the page declares is present.
    for (const field of readFields(step.content)) {
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
      // Capture the lead. Known field names map onto contact identity; everything
      // else is preserved by the merge fields the workflow runner reads.
      const contactsRepo = new ContactsRepo(tx, loc)
      const { contact, created } = await contactsRepo.upsertByMatch(
        {
          name: values.full_name ?? values.name,
          email: values.email,
          phone: values.phone,
        },
        `funnel:${slug}`,
      )

      const tag = typeof step.content.tag === 'string' ? step.content.tag : undefined
      if (tag) await contactsRepo.addTag(contact.id, tag)

      await new FunnelStepsRepo(tx, loc).incrementSubmissions(step.id)
      await new TimelineRepo(tx, loc).add({
        contactId: contact.id,
        type: 'funnel_submission',
        refTable: 'funnel_steps',
        refId: step.id,
        payload: { funnel: slug, step: path },
      })

      // The new-contact automation intent commits WITH the capture under a
      // STABLE event id; fast dispatch below fires post-commit and the
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
      const scope = { locationId: loc, operation: 'funnel-submit', key: key ?? '', payload: { slug, path, values } }
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

      // Where the visitor goes next (the following page, if any).
      const steps = await stepsRepo.listByFunnel(funnel.id)
      const next = steps.find((s) => s.position > step.position)?.path ?? null
      return c.json({ ok: true, ...settled.result.out, next, ...(settled.reused ? { deduped: true } : {}) })
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
