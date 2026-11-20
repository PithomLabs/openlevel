import { nanoid } from 'nanoid'
import { LocationScopedRepo } from './base-repo'

export interface Campaign {
  id: string
  location_id: string
  name: string
  channel: string
  subject: string | null
  body: string
  audience_tag: string | null
  status: string
  recipient_count: number
  sent_count: number
  created_at: string
  updated_at: string
  sent_at: string | null
}

export interface CampaignInput {
  name: string
  channel?: string
  subject?: string | null
  body: string
  audienceTag?: string | null
}

export class CampaignsRepo extends LocationScopedRepo {
  list(): Promise<Campaign[]> {
    return this.scopedSelect<Campaign>('SELECT * FROM campaigns ORDER BY created_at DESC')
  }

  async get(id: string): Promise<Campaign | undefined> {
    const rows = await this.scopedSelect<Campaign>('SELECT * FROM campaigns WHERE id=$2', [id])
    return rows[0]
  }

  async create(input: CampaignInput): Promise<Campaign> {
    const id = nanoid()
    const rows = await this.scopedWrite<Campaign>(
      `INSERT INTO campaigns (id, location_id, name, channel, subject, body, audience_tag)
       VALUES ($2,$1,$3,$4,$5,$6,$7) RETURNING *`,
      [id, input.name, input.channel ?? 'sms', input.subject ?? null, input.body, input.audienceTag ?? null],
    )
    return rows[0]!
  }

  /** Flip a draft to sent, stamping the recipient/sent counts and sent_at. */
  async markSent(id: string, recipientCount: number, sentCount: number): Promise<Campaign | undefined> {
    const rows = await this.scopedWrite<Campaign>(
      `UPDATE campaigns
         SET status='sent', recipient_count=$2, sent_count=$3, sent_at=now(), updated_at=now()
       WHERE location_id=$1 AND id=$4 RETURNING *`,
      [recipientCount, sentCount, id],
    )
    return rows[0]
  }

  /**
   * Atomically claim a campaign for sending (FIND-07). Wins for drafts and
   * for sends abandoned mid-flight (status 'sending' untouched for 30+ min);
   * concurrent twins and already-sent campaigns get no row back. The single
   * UPDATE is the whole race protection — no read-then-act.
   */
  async claimForSend(id: string): Promise<Campaign | undefined> {
    const rows = await this.scopedWrite<Campaign>(
      `UPDATE campaigns SET status='sending', updated_at=now()
       WHERE location_id=$1 AND id=$2
         AND (status='draft' OR (status='sending' AND updated_at < now() - make_interval(mins => 30)))
       RETURNING *`,
      [id],
    )
    return rows[0]
  }

  /**
   * Release a claim taken but never acted on (R13-11): when the send engine
   * refuses before any provider operation (no provider connected), the
   * campaign returns to retryable `draft` instead of sitting in `sending`
   * until the 30-minute stale window expires. Only releases OUR claim — a
   * terminal row (sent/cancelled) is never touched.
   */
  async releaseClaim(id: string): Promise<Campaign | undefined> {
    const rows = await this.scopedWrite<Campaign>(
      `UPDATE campaigns SET status='draft', updated_at=now()
       WHERE location_id=$1 AND id=$2 AND status='sending'
       RETURNING *`,
      [id],
    )
    return rows[0]
  }

  /**
   * Cancel a campaign (R13-11): atomic single statement — after it commits,
   * no new recipient attempt may start (the send loop checks per recipient)
   * and no new send may claim (terminal statuses never match claimForSend).
   * An already in-flight provider request runs to completion; cancellation
   * cannot reverse an accepted send. Returns undefined for missing or
   * already-terminal campaigns.
   */
  async cancel(id: string): Promise<Campaign | undefined> {
    const rows = await this.scopedWrite<Campaign>(
      `UPDATE campaigns SET status='cancelled', updated_at=now()
       WHERE location_id=$1 AND id=$2 AND status IN ('draft', 'sending')
       RETURNING *`,
      [id],
    )
    return rows[0]
  }
}
