import type { Database } from '../db/database'
import { ChannelLinksRepo } from '../repos/channel-links-repo'
import { ConversationsRepo } from '../repos/conversations-repo'
import { type Message, MessagesRepo } from '../repos/messages-repo'
import { TimelineRepo } from '../repos/timeline-repo'
import { sendChatwootMessage } from './chatwoot-client'
import { sideEffectPolicyFromEnv } from './sending/policy'
import { recordSinkMessage } from './sending/sink'
import { resolveSecret as defaultResolveSecret } from './vault'

export interface OutboundDeps {
  /** Injectable for tests — defaults to the real Chatwoot HTTP adapter. */
  sendMessage?: typeof sendChatwootMessage
  /** Injectable for tests — defaults to the env/Vaultwarden secret resolver. */
  resolveSecret?: typeof defaultResolveSecret
  /** Injectable for tests — defaults to process.env (staging fence). */
  env?: Record<string, string | undefined>
}

export interface OutboundInput {
  conversationId: string
  body: string
  /** 'operator' for the human composer, 'agent' for an autonomous reply. */
  authorType: string
  authorId: string | null
}

export interface OutboundResult {
  ok: boolean
  status: 200 | 400 | 404
  error?: string
  message?: Message
  /** True when the fence routed this send to the sink: recorded, not delivered. */
  simulated?: boolean
}

/**
 * Federate a message OUT through a conversation's channel (Chatwoot today), then
 * persist the outbound message + a timeline event + touch the conversation. The
 * single outbound code path shared by the operator composer (conversations route)
 * and the autonomous agent-reply job, so both go through identical persistence
 * and the unified record reflects the send immediately.
 */
export async function sendOutboundMessage(
  db: Database,
  locationId: string,
  input: OutboundInput,
  deps: OutboundDeps = {},
): Promise<OutboundResult> {
  const send = deps.sendMessage ?? sendChatwootMessage
  const getSecret = deps.resolveSecret ?? defaultResolveSecret

  const conversations = new ConversationsRepo(db, locationId)
  const conversation = await conversations.get(input.conversationId)
  if (!conversation) return { ok: false, status: 404, error: 'not found' }

  const link = await new ChannelLinksRepo(db).getForLocation('chatwoot', locationId)
  if (!link) return { ok: false, status: 400, error: 'no chatwoot channel for this location' }
  const cfg = link.config as { baseUrl?: string; accountId?: string; tokenSecretName?: string }
  const token = cfg.tokenSecretName ? getSecret(cfg.tokenSecretName) : undefined
  if (!cfg.baseUrl || !cfg.accountId || !token) {
    return { ok: false, status: 400, error: 'chatwoot channel is not fully configured' }
  }
  if (!conversation.external_id) {
    return { ok: false, status: 400, error: 'conversation has no chatwoot id' }
  }

  // Central side-effect policy (R14-03): staging sinks unconditionally
  // (Chatwoot conversations carry no allowlist-able recipient) — the message
  // is recorded locally and honestly marked simulated instead of reaching
  // Chatwoot. Restricted preview / malformed identity refuses outright.
  const policy = sideEffectPolicyFromEnv(deps.env ?? process.env)
  if (policy.mode === 'refuse') {
    return { ok: false, status: 400, error: policy.reason }
  }
  let sent: { externalId: string }
  let simulated = false
  if (policy.mode === 'sink') {
    sent = await recordSinkMessage(db, locationId, {
      channel: 'chatwoot',
      recipient: `chatwoot:${conversation.external_id}`,
      body: input.body,
    })
    simulated = true
  } else {
    sent = await send({
      baseUrl: cfg.baseUrl,
      accountId: cfg.accountId,
      conversationId: conversation.external_id,
      token,
      content: input.body,
    })
  }

  const message = await new MessagesRepo(db, locationId).insertOutbound({
    conversationId: input.conversationId,
    contactId: conversation.contact_id,
    channel: 'chatwoot',
    provider: simulated ? 'sink' : 'chatwoot',
    externalId: sent.externalId,
    body: input.body,
    authorType: input.authorType,
    authorId: input.authorId,
    // R13-07: a sunk message is 'simulated', never 'sent' — status and
    // provider agree, so no reader can mistake a recording for delivery.
    status: simulated ? 'simulated' : 'sent',
  })
  await new TimelineRepo(db, locationId).add({
    contactId: conversation.contact_id,
    type: 'message',
    refTable: 'messages',
    refId: message.id,
    payload: {
      direction: 'outbound',
      body: input.body,
      channel: 'chatwoot',
      ...(simulated ? { simulated: true } : {}),
    },
  })
  await conversations.touch(input.conversationId)

  return { ok: true, status: 200, message, ...(simulated ? { simulated: true } : {}) }
}
