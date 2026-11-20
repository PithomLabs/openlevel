import { nanoid } from 'nanoid'
import { LocationScopedRepo } from './base-repo'

export interface CampaignRecipient {
  id: string
  location_id: string
  campaign_id: string
  contact_id: string | null
  status: string
  created_at: string
}

export class CampaignRecipientsRepo extends LocationScopedRepo {
  /**
   * Insert one recipient row per contact in a single multi-row INSERT. Every row
   * reuses $1 (location) and $2 (campaign); each contact contributes an id + a
   * contact_id placeholder. status falls back to the column default ('sent').
   */
  async bulkInsert(campaignId: string, contactIds: string[]): Promise<CampaignRecipient[]> {
    if (contactIds.length === 0) return []
    const extra: unknown[] = [campaignId]
    const groups: string[] = []
    contactIds.forEach((cid, i) => {
      const idIdx = 3 + i * 2 // $3, $5, $7, ...
      const contactIdx = 4 + i * 2 // $4, $6, $8, ...
      extra.push(nanoid(), cid)
      groups.push(`($${idIdx},$1,$2,$${contactIdx})`)
    })
    return this.scopedWrite<CampaignRecipient>(
      `INSERT INTO campaign_recipients (id, location_id, campaign_id, contact_id)
       VALUES ${groups.join(',')} RETURNING *`,
      extra,
    )
  }

  /**
   * Status-aware variant for the real send path (Module 49): one row per
   * contact carrying its actual delivery outcome ('sent' | 'skipped' |
   * 'failed'), so the recipients list never claims a send that didn't happen.
   */
  async bulkInsertOutcomes(
    campaignId: string,
    outcomes: { contactId: string; status: string }[],
  ): Promise<CampaignRecipient[]> {
    if (outcomes.length === 0) return []
    const extra: unknown[] = [campaignId]
    const groups: string[] = []
    outcomes.forEach((o, i) => {
      const idIdx = 3 + i * 3 // $3, $6, $9, ...
      extra.push(nanoid(), o.contactId, o.status)
      groups.push(`($${idIdx},$1,$2,$${idIdx + 1},$${idIdx + 2})`)
    })
    return this.scopedWrite<CampaignRecipient>(
      `INSERT INTO campaign_recipients (id, location_id, campaign_id, contact_id, status)
       VALUES ${groups.join(',')} RETURNING *`,
      extra,
    )
  }

  listByCampaign(campaignId: string): Promise<CampaignRecipient[]> {
    return this.scopedSelect<CampaignRecipient>(
      'SELECT * FROM campaign_recipients WHERE campaign_id=$2 ORDER BY created_at',
      [campaignId],
    )
  }

  /**
   * Pre-register the send set as pending (FIND-07). ON CONFLICT DO NOTHING
   * makes resume-after-crash safe: already-recorded recipients keep their
   * outcomes while new ones start pending.
   */
  async markPending(campaignId: string, contactIds: string[]): Promise<void> {
    if (contactIds.length === 0) return
    const extra: unknown[] = [campaignId]
    const groups: string[] = []
    contactIds.forEach((cid, i) => {
      const idIdx = 3 + i * 2
      extra.push(nanoid(), cid)
      groups.push(`($${idIdx},$1,$2,$${idIdx + 1},'pending')`)
    })
    await this.scopedWrite(
      `INSERT INTO campaign_recipients (id, location_id, campaign_id, contact_id, status)
       VALUES ${groups.join(',')}
       ON CONFLICT (location_id, campaign_id, contact_id) WHERE contact_id IS NOT NULL DO NOTHING`,
      extra,
    )
  }

  /** Contacts already confirmed sent through a real provider (real sends only — feeds sent_count). */
  async sentContactIds(campaignId: string): Promise<Set<string>> {
    const rows = await this.scopedSelect<{ contact_id: string }>(
      `SELECT contact_id FROM campaign_recipients WHERE campaign_id=$2 AND status='sent'`,
      [campaignId],
    )
    return new Set(rows.map((r) => r.contact_id))
  }

  /** Contacts with a terminal completed outcome, real or simulated (resume skips exactly these). */
  async completedContactIds(campaignId: string): Promise<Set<string>> {
    const rows = await this.scopedSelect<{ contact_id: string }>(
      `SELECT contact_id FROM campaign_recipients WHERE campaign_id=$2 AND status IN ('sent', 'simulated')`,
      [campaignId],
    )
    return new Set(rows.map((r) => r.contact_id))
  }

  /**
   * Contacts stuck mid-send (N5): a previous attempt recorded 'sending' but
   * never recorded an outcome — the provider may or may not have accepted.
   * Resume quarantines these instead of blindly resending.
   */
  async sendingContactIds(campaignId: string): Promise<Set<string>> {
    const rows = await this.scopedSelect<{ contact_id: string }>(
      `SELECT contact_id FROM campaign_recipients WHERE campaign_id=$2 AND status='sending'`,
      [campaignId],
    )
    return new Set(rows.map((r) => r.contact_id))
  }

  /** Persist one recipient's terminal outcome as the send loop decides it. */
  async recordOutcome(campaignId: string, contactId: string, status: string): Promise<void> {
    await this.scopedWrite(
      `UPDATE campaign_recipients SET status=$4
       WHERE location_id=$1 AND campaign_id=$2 AND contact_id=$3`,
      [campaignId, contactId, status],
    )
  }
}
