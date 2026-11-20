import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../app-env'
import type { Database } from '../db/database'
import type { WorkflowDispatch, WorkflowEvent } from '../jobs/workflow-dispatcher'
import {
  IdempotencyConflict,
  IdempotencyInProgress,
  InvalidIdempotencyKey,
  completeIdempotencyKey,
  parseIdempotencyKey,
  withIdempotency,
} from '../lib/idempotency'
import { readAllFields } from '../lib/page-html'
import { renderSurveyNotFound, renderSurveyPage } from '../lib/survey-page'
import { ContactsRepo } from '../repos/contacts-repo'
import { LocationsRepo } from '../repos/locations-repo'
import { OutboxRepo } from '../repos/outbox-repo'
import { SurveySubmissionsRepo } from '../repos/survey-submissions-repo'
import { SurveysRepo } from '../repos/surveys-repo'
import { TimelineRepo } from '../repos/timeline-repo'

const submitSchema = z.object({
  values: z.record(z.string(), z.string()).default({}),
})

/**
 * Public, UNAUTHENTICATED multi-step surveys — mounted at `/api/public/surveys`
 * BEFORE the operatorAuth boundary, so it reads the location from the URL
 * (`:loc`) itself.
 *
 *   GET  /:loc/:slug         → a published survey (visitor render, all steps)
 *   POST /:loc/:slug/submit  → capture every step's answers in one shot
 *
 * The submit runs the same capture keystone as a form — upsert a contact, apply
 * an optional tag, store the raw answers, bump the honest counter, log a
 * timeline event — and dispatches BOTH `survey_submitted` (the specific trigger
 * a workflow can key off) AND `contact_created` (so a finished survey enrolls
 * the lead in the generic new-contact automations too). Only published surveys
 * are reachable; required fields are validated against every step's fields.
 */
export function publicSurveysRoute(deps: {
  db: Database
  /** Fired after a capture so live workflows enroll the contact. */
  dispatch?: WorkflowDispatch
}): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  /** The location's branding color (for the CTA + accents), or undefined. */
  async function brandColor(loc: string): Promise<string | undefined> {
    const location = await new LocationsRepo(deps.db).getById(loc)
    const color = location?.branding.color
    return typeof color === 'string' ? color : undefined
  }

  // A published survey renders as a real, hostable multi-step HTML page.
  // Unpublished or unknown → a styled 404 page.
  app.get('/:loc/:slug', async (c) => {
    const loc = c.req.param('loc')
    const slug = c.req.param('slug')
    const survey = await new SurveysRepo(deps.db, loc).getBySlug(slug)
    if (!survey || survey.status !== 'published') return c.html(renderSurveyNotFound(), 404)
    return c.html(renderSurveyPage(survey, { brandColor: await brandColor(loc) }))
  })

  app.post('/:loc/:slug/submit', zValidator('json', submitSchema), async (c) => {
    const loc = c.req.param('loc')
    const slug = c.req.param('slug')
    const { values } = c.req.valid('json')

    const surveysRepo = new SurveysRepo(deps.db, loc)
    const survey = await surveysRepo.getBySlug(slug)
    if (!survey || survey.status !== 'published') return c.json({ error: 'not found' }, 404)

    // Validate every required field across ALL steps is present. The renderer and
    // this check read the same readAllFields, so they can never disagree.
    for (const field of readAllFields(survey.content)) {
      if (field.required && !values[field.name]?.trim()) {
        return c.json({ error: 'missing required field', field: field.name }, 400)
      }
    }

    // Submission identity (R14-01, approval G3): an explicit Idempotency-Key
    // makes a retry one logical submission. WITHOUT a key every submit
    // executes — surveys are answered repeatedly, and two identical answer
    // sets stay two distinct responses. No content-derived fallback:
    // payload equality must never collapse surveys. API contract: clients
    // needing retry safety MUST supply a stable key.
    const keyHeader = c.req.header('Idempotency-Key')
    const capture = async (tx: Database) => {
      // Capture the lead. Known field names map onto contact identity; the full
      // raw answers map is preserved on the stored submission below.
      const contactsRepo = new ContactsRepo(tx, loc)
      const { contact, created } = await contactsRepo.upsertByMatch(
        {
          name: values.full_name ?? values.name,
          email: values.email,
          phone: values.phone,
        },
        `survey:${slug}`,
      )

      const tag = typeof survey.content.tag === 'string' ? survey.content.tag : undefined
      if (tag) await contactsRepo.addTag(contact.id, tag)

      // STORE the raw answers — the operator submissions viewer reads these back.
      const submission = await new SurveySubmissionsRepo(tx, loc).create({
        surveyId: survey.id,
        contactId: contact.id,
        values,
      })

      await new SurveysRepo(tx, loc).incrementSubmissions(survey.id)
      await new TimelineRepo(tx, loc).add({
        contactId: contact.id,
        type: 'survey_submission',
        refTable: 'surveys',
        refId: survey.id,
        payload: { survey: slug },
      })

      // Automation intents commit WITH the capture under STABLE event ids;
      // fast dispatch below fires post-commit and the sweeper covers a crash
      // between them. Redelivery converges.
      const events: WorkflowEvent[] = []
      const queue = async (eventId: string, triggerType: 'survey_submitted' | 'contact_created', aggregateId: string) => {
        await new OutboxRepo(tx, loc).insert({
          id: eventId,
          aggregate: triggerType === 'survey_submitted' ? 'survey_submission' : 'contact',
          aggregateId,
          event: triggerType,
          payload: { contactId: contact.id },
        })
        events.push({ locationId: loc, triggerType, contactId: contact.id, eventId })
      }
      await queue(`survey-submitted:${submission.id}`, 'survey_submitted', submission.id)
      if (created) await queue(`contact-created:${contact.id}`, 'contact_created', contact.id)
      return { out: { contactId: contact.id }, events }
    }
    try {
      const key = parseIdempotencyKey(keyHeader)
      const scope = { locationId: loc, operation: 'survey-submit', key: key ?? '', payload: { slug, values } }
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
