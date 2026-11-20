import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { Hono } from 'hono'
import type { Database } from '../db/database'
import type { WorkflowDispatch } from '../jobs/workflow-dispatcher'
import { ChannelLinksRepo } from '../repos/channel-links-repo'
import { ContactsRepo } from '../repos/contacts-repo'
import { ConversationsRepo } from '../repos/conversations-repo'
import { MessagesRepo } from '../repos/messages-repo'
import { TimelineRepo } from '../repos/timeline-repo'
import { type ChatwootWebhookPayload, parseChatwootEvent } from '../lib/chatwoot-inbound'

/**
 * Constant-time secret check. A plain `a !== b` short-circuits on the first
 * differing byte, so how long the rejection takes leaks how many leading bytes
 * matched - enough, in principle, for a remote attacker to recover the secret one
 * byte at a time. Hashing both sides to a fixed 32-byte digest first means
 * timingSafeEqual always compares equal-length buffers (it throws on a length
 * mismatch) without leaking the secret's length, and the compare itself runs in
 * time independent of where the inputs first differ.
 */
function secretsMatch(provided: string, expected: string): boolean {
  const a = createHash('sha256').update(provided).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

/** Replay window for Chatwoot's signed timestamp (Review 11 G6). */
const SIGNATURE_FRESHNESS_MS = 300_000

/**
 * Verify Chatwoot's native webhook signature (per Chatwoot's documented
 * scheme): `X-Chatwoot-Signature: sha256=HMAC-SHA256(secret, ts + "." + rawBody)`.
 * Compared through the same length-hiding digest trick as secretsMatch.
 */
export function chatwootSignatureValid(
  webhookSecret: string,
  timestamp: string,
  rawBody: string,
  provided: string,
): boolean {
  if (provided === '' || !/^\d+$/.test(timestamp)) return false
  const expected = `sha256=${createHmac('sha256', webhookSecret).update(`${timestamp}.${rawBody}`).digest('hex')}`
  const a = createHash('sha256').update(provided).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

export interface InboundEvent {
  locationId: string
  conversationId: string
  contactId: string
  messageId: string
  /** Best-effort display name for a push title; falls back to the webhook sender's name. */
  contactName?: string
  /** Raw inbound text, used only for a push body preview. */
  preview?: string
}

export interface ChatwootWebhookDeps {
  db: Database
  webhookSecret: string
  /** Optional hook (Phase E): enqueue agent.reply.dispatch after a fresh inbound. */
  onInbound?: (e: InboundEvent) => void | Promise<void>
  /** Fires contact_created for genuinely new inbound contacts (FIND-07). */
  dispatch?: WorkflowDispatch
  /** Injectable wall clock (epoch ms) for signature freshness; tests pin it. */
  now?: () => number
}

export function chatwootWebhookRoute(deps: ChatwootWebhookDeps): Hono {
  const app = new Hono()

  app.post('/', async (c) => {
    // Header-only authentication (Review 11 G6). ?secret= was removed: a URL
    // secret lands in proxy access logs and Fly offers no query scrubbing,
    // so no redaction story could cover it. Two accepted paths: our shared
    // header (relays/self-hosted setups that can set it), or Chatwoot's own
    // HMAC signature over timestamp + raw body. Either must verify fully.
    const rawBody = await c.req.text()
    const headerOk = secretsMatch(c.req.header('x-webhook-secret') ?? '', deps.webhookSecret)
    const timestamp = c.req.header('x-chatwoot-timestamp') ?? ''
    const signature = c.req.header('x-chatwoot-signature') ?? ''
    const now = deps.now?.() ?? Date.now()
    const fresh =
      /^\d+$/.test(timestamp) && Math.abs(now - Number(timestamp) * 1000) <= SIGNATURE_FRESHNESS_MS
    const sigOk =
      signature !== '' && fresh && chatwootSignatureValid(deps.webhookSecret, timestamp, rawBody, signature)
    if (!headerOk && !sigOk) return c.json({ error: 'unauthorized' }, 401)

    const payload: ChatwootWebhookPayload | null = (() => {
      try {
        return JSON.parse(rawBody) as ChatwootWebhookPayload
      } catch {
        return null
      }
    })()
    const event = payload ? parseChatwootEvent(payload) : null
    if (!event) return c.json({ ignored: true }, 200)

    const channel = await new ChannelLinksRepo(deps.db).resolveLocation('chatwoot', event.inboxId)
    if (!channel) return c.json({ ignored: 'no channel link' }, 200)
    const loc = channel.locationId

    const { contact, created } = await new ContactsRepo(deps.db, loc).upsertByMatch(event.contact, 'chatwoot')
    const conversations = new ConversationsRepo(deps.db, loc)
    const conversation = await conversations.upsertByExternal({
      provider: 'chatwoot',
      externalId: event.externalConversationId,
      contactId: contact.id,
      channel: 'chatwoot',
    })
    const message = await new MessagesRepo(deps.db, loc).insertInbound({
      conversationId: conversation.id,
      contactId: contact.id,
      channel: 'chatwoot',
      provider: 'chatwoot',
      externalId: event.externalMessageId,
      body: event.body,
    })
    if (!message) return c.json({ ok: true, deduped: true }, 200)

    await new TimelineRepo(deps.db, loc).add({
      contactId: contact.id,
      type: 'message',
      refTable: 'messages',
      refId: message.id,
      payload: { direction: 'inbound', body: event.body, channel: 'chatwoot' },
    })
    await conversations.touch(conversation.id)

    // Entry convergence (FIND-07): an inbound from a brand-new contact also
    // fires contact_created (deduped downstream by event_id), so welcome
    // automations treat every capture path the same.
    if (created) {
      await deps.dispatch?.({
        locationId: loc,
        triggerType: 'contact_created',
        contactId: contact.id,
        eventId: randomUUID(),
      })
    }

    if (deps.onInbound) {
      await deps.onInbound({
        locationId: loc,
        conversationId: conversation.id,
        contactId: contact.id,
        messageId: message.id,
        contactName: contact.name ?? event.contact.name,
        preview: event.body,
      })
    }

    return c.json(
      { ok: true, contactId: contact.id, conversationId: conversation.id, messageId: message.id },
      200,
    )
  })

  return app
}
