import { randomUUID } from 'node:crypto'
import type { Database } from '../../db/database'
import { assertSinkRecipient, type StagingFence } from './fence'
import type { EmailMessage, EmailSender, SendResult, SmsMessage, SmsSender } from './provider'

/**
 * Record one would-be send into `outbound_sink`. Shared by the email/SMS
 * sink sender and by channel-specific fenced paths (Chatwoot) that have no
 * allowlist-able recipient of their own.
 */
export async function recordSinkMessage(
  db: Pick<Database, 'query'>,
  locationId: string,
  input: { channel: string; recipient: string; subject?: string | null; body: string },
): Promise<SendResult> {
  const id = `sink-${randomUUID()}`
  await db.query(
    `INSERT INTO outbound_sink (id, location_id, channel, recipient, subject, body)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, locationId, input.channel, input.recipient, input.subject ?? null, input.body],
  )
  return { externalId: id, provider: 'sink' }
}

/**
 * Controlled message sink (N5/N15). Implements the provider contracts by
 * recording every would-be send into `outbound_sink` instead of calling a
 * provider. Every send asserts the staging fence first: unlisted recipients
 * throw FenceRefusal and NOTHING is recorded (a refusal is not an attempt).
 */
export function createSinkSender(
  db: Pick<Database, 'query'>,
  locationId: string,
  fence: StagingFence,
): EmailSender & SmsSender {
  const record = async (
    channel: string,
    recipient: string,
    subject: string | null,
    body: string,
  ): Promise<SendResult> => {
    assertSinkRecipient(fence, recipient)
    return recordSinkMessage(db, locationId, { channel, recipient, subject, body })
  }
  return {
    name: 'sink',
    sendEmail: (msg: EmailMessage) => record('email', msg.to, msg.subject, msg.text),
    sendSms: (msg: SmsMessage) => record('sms', msg.to, null, msg.body),
  }
}
