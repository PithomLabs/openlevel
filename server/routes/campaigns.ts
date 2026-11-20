import { randomUUID } from 'node:crypto'
import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../app-env'
import type { Database } from '../db/database'
import { IdempotencyConflict, IdempotencyInProgress, withIdempotency } from '../lib/idempotency'
import { sendCampaign } from '../lib/sending/campaign-send'
import { CampaignRecipientsRepo } from '../repos/campaign-recipients-repo'
import { CampaignsRepo } from '../repos/campaigns-repo'
import { type Contact, ContactsRepo } from '../repos/contacts-repo'
import { CustomValuesRepo } from '../repos/custom-values-repo'

const CHANNELS = ['sms', 'email'] as const

const createCampaignSchema = z.object({
  name: z.string().min(1),
  channel: z.enum(CHANNELS).default('sms'),
  subject: z.string().nullable().optional(),
  body: z.string().min(1),
  audienceTag: z.string().nullable().optional(),
})

// Cap a single blast so an accidental "all contacts" send can't fan out unbounded.
const MAX_AUDIENCE = 5000

/**
 * Marketing campaigns for the current location. Mounted behind operatorAuth +
 * locationAccess. GET / lists; POST / drafts; GET /:id returns the campaign with
 * its recipients; POST /:id/send resolves the audience (all contacts or a tag
 * segment) and fans the blast out through the LOCATION's own provider (Brevo
 * email / Twilio SMS, Module 49). No provider connected = an honest 409, the
 * campaign stays draft, and nothing pretends to deliver. Each recipient row
 * records the real outcome (sent/skipped/failed); sent_count counts only
 * messages the provider actually accepted.
 */
export function campaignsRoute(deps: { db: Database; send?: typeof sendCampaign }): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.get('/', async (c) => {
    const loc = c.get('locationId')
    const campaigns = await new CampaignsRepo(deps.db, loc).list()
    return c.json({ campaigns })
  })

  app.post('/', zValidator('json', createCampaignSchema), async (c) => {
    const loc = c.get('locationId')
    const campaign = await new CampaignsRepo(deps.db, loc).create(c.req.valid('json'))
    return c.json({ ok: true, campaign }, 201)
  })

  app.get('/:id', async (c) => {
    const loc = c.get('locationId')
    const id = c.req.param('id')
    const campaign = await new CampaignsRepo(deps.db, loc).get(id)
    if (!campaign) return c.json({ error: 'not found' }, 404)
    const recipients = await new CampaignRecipientsRepo(deps.db, loc).listByCampaign(id)
    return c.json({ campaign, recipients })
  })

  app.post('/:id/send', async (c) => {
    const loc = c.get('locationId')
    const id = c.req.param('id')
    const campaigns = new CampaignsRepo(deps.db, loc)

    const campaign = await campaigns.get(id)
    if (!campaign) return c.json({ error: 'not found' }, 404)

    const contactsRepo = new ContactsRepo(deps.db, loc)
    const audience =
      campaign.audience_tag != null && campaign.audience_tag !== ''
        ? await contactsRepo.listByTag(campaign.audience_tag)
        : await contactsRepo.list(MAX_AUDIENCE)
    if (audience.length === 0) return c.json({ error: 'no matching contacts' }, 400)

    // Idempotency around the send itself (FIND-07, G3): same key + same
    // campaign replays the recorded summary; same key + another campaign
    // conflicts. No header means no cross-retry dedup (fresh random key) —
    // the atomic claim below still prevents double-sending, it just answers
    // 409 instead of replaying.
    const key = c.req.header('Idempotency-Key') ?? randomUUID()
    try {
      const { result, reused } = await withIdempotency(
        deps.db,
        { locationId: loc, operation: 'campaign-send', key, payload: { campaignId: id } },
        () => executeSend(deps, loc, id, audience),
      )
      if (!result.ok) return c.json({ error: result.reason }, 409)
      return c.json({
        ok: true,
        campaign: result.campaign,
        delivery: result.delivery,
        simulated: result.simulated,
        cancelled: result.cancelled,
        ...(reused ? { deduped: true } : {}),
      })
    } catch (err) {
      if (err instanceof IdempotencyConflict || err instanceof IdempotencyInProgress) {
        return c.json({ error: err.message }, 409)
      }
      if (err instanceof CampaignBusy) return c.json({ error: err.message }, 409)
      throw err
    }
  })

  app.post('/:id/cancel', async (c) => {
    const loc = c.get('locationId')
    const id = c.req.param('id')
    const campaigns = new CampaignsRepo(deps.db, loc)
    const current = await campaigns.get(id)
    if (!current) return c.json({ error: 'not found' }, 404)
    if (current.status === 'sent' || current.status === 'cancelled') {
      return c.json({ error: `campaign already ${current.status}` }, 409)
    }
    const cancelled = await campaigns.cancel(id)
    if (!cancelled) return c.json({ error: 'campaign could not be cancelled' }, 409)
    return c.json({ ok: true, campaign: cancelled })
  })

  return app
}

/** A send refused because the campaign is already sent, sending, or cancelled. */
export class CampaignBusy extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CampaignBusy'
  }
}

interface CampaignSendSummary {
  ok: true
  campaign: unknown
  delivery: { sent: number; skipped: number; failed: number; quarantined: number; simulated: number }
  /** True when the fence routed this send to the sink: recorded, not delivered. */
  simulated: boolean
  /** True when the operator cancelled mid-blast: partial outcomes, no markSent. */
  cancelled: boolean
}

interface CampaignSendRefused {
  ok: false
  reason: string
}

/**
 * One campaign send attempt (FIND-07). Claim → resolve audience → pre-insert
 * pending rows → send (skipping already-sent on resume) with per-recipient
 * persistence → mark sent. Concurrent twins collapse at the claim; a crash
 * leaves pending/failed rows a later attempt resumes instead of re-blasting.
 */
async function executeSend(
  deps: { db: Database; send?: typeof sendCampaign },
  loc: string,
  id: string,
  audience: Contact[],
): Promise<CampaignSendSummary | CampaignSendRefused> {
  const campaigns = new CampaignsRepo(deps.db, loc)
  const recipients = new CampaignRecipientsRepo(deps.db, loc)

  const claimed = await campaigns.claimForSend(id)
  if (!claimed) {
    const current = await campaigns.get(id)
    if (current?.status === 'sent') throw new CampaignBusy('campaign already sent')
    if (current?.status === 'cancelled') throw new CampaignBusy('campaign was cancelled')
    throw new CampaignBusy('campaign send already in progress')
  }

  await recipients.markPending(
    id,
    audience.map((contact) => contact.id),
  )
  const alreadySent = await recipients.sentContactIds(id)
  const completed = await recipients.completedContactIds(id)
  // N5 quarantine: rows stuck in 'sending' mean a previous attempt died
  // between provider-accept and outcome-record — the outcome is UNCERTAIN,
  // so resume skips them instead of risking a duplicate delivery. They stay
  // visible for operator reconciliation (re-adding the contact re-queues it).
  const quarantined = await recipients.sendingContactIds(id)
  const toSend = audience.filter(
    (contact) => !completed.has(contact.id) && !quarantined.has(contact.id),
  )

  const customValues = await new CustomValuesRepo(deps.db, loc).map()
  const result = await (deps.send ?? sendCampaign)(
    {
      db: deps.db,
      onOutcome: (contactId, status) => recipients.recordOutcome(id, contactId, status),
      onSending: (contactId) => recipients.recordOutcome(id, contactId, 'sending'),
      // R13-11: the loop consults cancellation before every attempt; a
      // mid-blast cancel stops new sends without touching recorded ones.
      shouldStop: async () => (await campaigns.get(id))?.status === 'cancelled',
    },
    { locationId: loc, campaign: claimed, contacts: toSend, customValues },
  )
  if (!result.ok) {
    // R13-11: refusal happens before any provider operation, so release the
    // claim back to retryable draft instead of stranding it in `sending`.
    await campaigns.releaseClaim(id)
    return { ok: false, reason: result.reason }
  }
  // Delivery counts describe THIS attempt; recipient rows hold the full story.
  // sent counts real provider accepts only (R13-07); simulated counts sink writes.
  const delivery = {
    sent: result.sentCount,
    skipped: result.outcomes.filter((o) => o.status === 'skipped').length,
    failed: result.outcomes.filter((o) => o.status === 'failed').length,
    quarantined: quarantined.size,
    simulated: result.outcomes.filter((o) => o.status === 'simulated').length,
  }
  if (result.cancelled) {
    // Cancelled mid-blast: the campaign row already says `cancelled` (the
    // cancel endpoint wrote it); do NOT markSent over it. Partial outcomes
    // stand as recorded; unsent recipients stay pending and visible.
    const current = await campaigns.get(id)
    return { ok: true, campaign: current, delivery, simulated: result.simulated, cancelled: true }
  }

  const priorSent = alreadySent.size
  const updated = await campaigns.markSent(id, audience.length, priorSent + result.sentCount)
  return { ok: true, campaign: updated, delivery, simulated: result.simulated, cancelled: false }
}
