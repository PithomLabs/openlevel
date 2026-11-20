import type { Database } from '../../db/database'
import { assertSinkRecipient, type StagingFence } from '../sending/fence'
import { recordSinkMessage } from '../sending/sink'
import type { CallEvent, OutboundCallRequest, PlacedCall, VoiceProvider, WebhookInput } from './provider'

/**
 * Sink voice adapter (R13-01). Records would-be outbound calls into
 * `outbound_sink` instead of invoking Twilio/Vapi. Every placement asserts
 * the staging fence: unlisted recipients throw FenceRefusal and nothing is
 * recorded.
 *
 * Inbound verification is deliberately fail-closed: a sink can never
 * authenticate a webhook (there is no live provider secret to verify
 * against), so forged or replayed inbound deliveries always 401 and the
 * parser is total-but-unreachable. The sink is never evidence of a call.
 */
export function createSinkVoiceAdapter(
  db: Pick<Database, 'query'>,
  locationId: string,
  fence: StagingFence,
): VoiceProvider {
  return {
    name: 'sink',
    async placeCall(req: OutboundCallRequest): Promise<PlacedCall> {
      assertSinkRecipient(fence, req.to)
      const recorded = await recordSinkMessage(db, locationId, {
        channel: 'voice',
        recipient: req.to,
        body: 'outbound voice call',
      })
      return { externalId: recorded.externalId, provider: 'sink' }
    },
    verifyWebhook(_input: WebhookInput): boolean {
      return false
    },
    parseEvent(_rawBody: string): CallEvent {
      return { type: 'ignored' }
    },
  }
}
