import { nanoid } from 'nanoid'
import { LocationScopedRepo } from './base-repo'
import { matchKey, normalizePhone, normalizeEmail } from '../lib/contact-match'

export interface Contact {
  id: string
  location_id: string
  name: string | null
  first_name: string | null
  last_name: string | null
  phones: string[]
  emails: string[]
  tags: string[]
  custom_fields: Record<string, unknown>
  source: string | null
  external_ids: Record<string, unknown>
  match_key: string | null
  created_at: string
  updated_at: string
  /** Soft-delete stamp: null = live (in the book); a timestamp = archived
   *  (hidden, restorable). Set by archive(), cleared by restore(). */
  archived_at: string | null
  /** US state (2-letter code) the contact is in. Pins which legal texting
   *  window the gateway enforces (8am-9pm in THAT state's timezone). null =
   *  not set, which the gateway blocks as unknown_state. Set by setState(). */
  state: string | null
}

export interface ContactInput {
  name?: string
  phone?: string
  email?: string
  externalIds?: Record<string, unknown>
}

/**
 * Conservative identity refusal (R13-12): the match is ambiguous or unsafe
 * to resolve automatically. Routes map this to a structured 409 — never a
 * silent merge, split, restore, or dropped identifier. Contact ids are
 * non-secret handles the operator uses to resolve the conflict explicitly.
 */
export class ContactIdentityConflict extends Error {
  readonly status = 409
  readonly code: 'archived_match' | 'identity_conflict'
  readonly contactIds: string[]
  constructor(code: 'archived_match' | 'identity_conflict', message: string, contactIds: string[]) {
    super(message)
    this.name = 'ContactIdentityConflict'
    this.code = code
    this.contactIds = contactIds
  }
}

export class ContactsRepo extends LocationScopedRepo {
  /** Independent phone lookup (includes archived — the caller decides).
   *  Digit-free junk never matches (same guard as matchKey). */
  async findByPhone(phone: string): Promise<Contact | undefined> {
    const normalized = normalizePhone(phone)
    if (!/\d/.test(normalized)) return undefined
    const rows = await this.scopedSelect<Contact>('SELECT * FROM contacts WHERE $2 = ANY(phones) LIMIT 1', [normalized])
    return rows[0]
  }

  /** Independent email lookup (includes archived — the caller decides). */
  async findByEmail(email: string): Promise<Contact | undefined> {
    const normalized = normalizeEmail(email)
    if (!normalized) return undefined
    const rows = await this.scopedSelect<Contact>('SELECT * FROM contacts WHERE $2 = ANY(emails) LIMIT 1', [normalized])
    return rows[0]
  }
  /**
   * Upsert by identity with conservative conflict refusal (R13-12): phone and
   * email are looked up INDEPENDENTLY, then reconciled — the single
   * phone-preferred match_key can no longer silently merge two contacts or
   * reuse an archived one.
   *
   * - Different contacts for phone vs email → identity_conflict (no merge).
   * - Any match on an archived contact → archived_match (no silent reuse,
   *   no duplicate under the same identity, no auto-restore).
   * - Compatible enrichment only: a new identifier is added only when the
   *   record lacks that identifier kind entirely AND no other contact holds
   *   it; a populated-different identifier is a conflict, never a silent
   *   add-or-drop.
   * - Keyless input (no usable phone/email) always inserts fresh, as before.
   *
   * `created` is true only when this call inserted (xmax idiom), so entry
   * points fire contact_created exactly once per contact. SELECT-then-INSERT
   * races still collapse on the match_key unique index; a race loser
   * re-validates against the winner's row (same enrich/conflict rules), so a
   * concurrent conflicting submit 409s instead of merging. Cross-key races
   * (twins inserting different keys for one person) can still split rows —
   * the conflict surface makes the split visible and resolvable on the next
   * submit; serializing all upserts per location was judged disproportionate.
   */
  async upsertByMatch(input: ContactInput, source: string): Promise<{ contact: Contact; created: boolean }> {
    const phone = input.phone ? normalizePhone(input.phone) : ''
    const email = input.email ? normalizeEmail(input.email) : ''
    const byPhone = input.phone ? await this.findByPhone(input.phone) : undefined
    const byEmail = input.email ? await this.findByEmail(input.email) : undefined
    if (byPhone && byEmail && byPhone.id !== byEmail.id) {
      throw new ContactIdentityConflict(
        'identity_conflict',
        'This phone number and email address belong to two different contacts — resolve them explicitly instead of merging.',
        [byPhone.id, byEmail.id],
      )
    }
    const target = byPhone ?? byEmail
    if (target?.archived_at) {
      throw new ContactIdentityConflict(
        'archived_match',
        'This submission matches an archived contact — restore it explicitly instead of reusing or duplicating it.',
        [target.id],
      )
    }
    if (target) return { contact: await this.reconcileOrThrow(target, input), created: false }
    const key = matchKey(this.locationId, input)
    const id = nanoid()
    const phones = input.phone && /\d/.test(phone) ? [phone] : []
    const emails = email ? [email] : []
    const rows = await this.db.query<Contact & { created: boolean }>(
      `INSERT INTO contacts (id, location_id, name, phones, emails, match_key, source, external_ids)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (location_id, match_key) WHERE match_key IS NOT NULL
       DO UPDATE SET match_key = EXCLUDED.match_key
       RETURNING *, (xmax = 0) AS created`,
      [id, this.locationId, input.name ?? null, phones, emails, key, source, input.externalIds ?? {}],
    )
    const row = rows[0]!
    const { created, ...contact } = row
    if (created !== true) {
      // Lost an exact-key race: the winner's row came back. Re-validate our
      // identifiers against it — a conflicting twin errors instead of merging.
      return { contact: await this.reconcileOrThrow(contact, input), created: false }
    }
    return { contact, created: true }
  }

  /**
   * Validate input identifiers against an existing row: compatible records
   * enrich (missing identifier kind only, uniqueness re-verified), anything
   * else conflicts. Never merges, drops, or overwrites populated data.
   */
  private async reconcileOrThrow(known: Contact, input: ContactInput): Promise<Contact> {
    if (known.archived_at) {
      throw new ContactIdentityConflict(
        'archived_match',
        'This submission matches an archived contact — restore it explicitly instead of reusing or duplicating it.',
        [known.id],
      )
    }
    const phone = input.phone ? normalizePhone(input.phone) : ''
    const email = input.email ? normalizeEmail(input.email) : ''
    const phoneKnown = !phone || phone === '' || !/\d/.test(phone) || known.phones.includes(phone)
    const emailKnown = !email || known.emails.includes(email)
    if (!phoneKnown && known.phones.length > 0) {
      throw new ContactIdentityConflict(
        'identity_conflict',
        'This submission carries a phone number that does not match the known contact — resolve it explicitly.',
        [known.id],
      )
    }
    if (!emailKnown && known.emails.length > 0) {
      throw new ContactIdentityConflict(
        'identity_conflict',
        'This submission carries an email address that does not match the known contact — resolve it explicitly.',
        [known.id],
      )
    }
    // Enrich only the missing kind, re-verifying uniqueness first (a twin may
    // have claimed it since our lookup).
    if (!phoneKnown && known.phones.length === 0) {
      const rival = await this.findByPhone(phone)
      if (rival && rival.id !== known.id) {
        throw new ContactIdentityConflict('identity_conflict', 'This phone number was just claimed by another contact.', [
          known.id,
          rival.id,
        ])
      }
      const rows = await this.db.query<Contact>(
        `UPDATE contacts SET phones = array_append(phones, $2), updated_at = now()
         WHERE id = $1 AND location_id = $3 AND NOT ($2 = ANY(phones)) RETURNING *`,
        [known.id, phone, this.locationId],
      )
      return rows[0] ?? known
    }
    if (!emailKnown && known.emails.length === 0) {
      const rival = await this.findByEmail(email)
      if (rival && rival.id !== known.id) {
        throw new ContactIdentityConflict('identity_conflict', 'This email address was just claimed by another contact.', [
          known.id,
          rival.id,
        ])
      }
      const rows = await this.db.query<Contact>(
        `UPDATE contacts SET emails = array_append(emails, $2), updated_at = now()
         WHERE id = $1 AND location_id = $3 AND NOT ($2 = ANY(emails)) RETURNING *`,
        [known.id, email, this.locationId],
      )
      return rows[0] ?? known
    }
    return known
  }

  list(limit = 50): Promise<Contact[]> {
    return this.scopedSelect<Contact>(
      'SELECT * FROM contacts WHERE archived_at IS NULL ORDER BY updated_at DESC LIMIT $2',
      [limit],
    )
  }

  /**
   * Total contacts in this location. Backs the operator assistant's list_contacts
   * tool — the headline answer to "how many leads/contacts do I have?", which the
   * search-only surface could not give. COUNT(*) returns a bigint that node-pg
   * hands back as a string, so the ::int cast keeps it a real number here and in
   * the FakeDatabase tests alike.
   */
  async count(): Promise<number> {
    const rows = await this.scopedSelect<{ n: number }>(
      'SELECT COUNT(*)::int AS n FROM contacts WHERE archived_at IS NULL',
      [],
    )
    return Number(rows[0]?.n ?? 0)
  }

  /**
   * Free-text lookup over name / phone / email, location-scoped, newest first.
   * Backs the operator assistant's search_contacts tool — it lets the agent turn
   * "book Altstatt" into a real contact id rather than guessing one. The arrays are
   * flattened to text so a single ILIKE pattern can match across all numbers/emails.
   */
  search(query: string, limit = 20): Promise<Contact[]> {
    const like = `%${query}%`
    return this.scopedSelect<Contact>(
      `SELECT * FROM contacts
         WHERE (name ILIKE $2 OR first_name ILIKE $2 OR last_name ILIKE $2
                OR array_to_string(phones, ' ') ILIKE $2
                OR array_to_string(emails, ' ') ILIKE $2)
           AND archived_at IS NULL
         ORDER BY updated_at DESC LIMIT $3`,
      [like, limit],
    )
  }

  /** Contacts carrying a given tag (pg text[] membership). Used for campaign
   *  audience segments. */
  listByTag(tag: string): Promise<Contact[]> {
    return this.scopedSelect<Contact>(
      'SELECT * FROM contacts WHERE $2 = ANY(tags) AND archived_at IS NULL ORDER BY updated_at DESC',
      [tag],
    )
  }

  async get(id: string): Promise<Contact | undefined> {
    // No archived_at filter on purpose: the detail page and the restore flow
    // must still be able to read an archived contact by id.
    const rows = await this.scopedSelect<Contact>('SELECT * FROM contacts WHERE id=$2', [id])
    return rows[0]
  }

  /**
   * Soft-delete a contact (the operator's "Delete" control). Stamps archived_at
   * so the row drops out of list/count/search/segments but is kept intact and
   * restorable — a hard delete would cascade away its notes/tasks/timeline and
   * null out its conversations/opportunities. Operator-only; the AI assistant
   * has no delete tool. Returns undefined if the id is not in this location.
   */
  async archive(id: string): Promise<Contact | undefined> {
    const rows = await this.scopedWrite<Contact>(
      `UPDATE contacts SET archived_at = now(), updated_at = now()
        WHERE location_id = $1 AND id = $2 RETURNING *`,
      [id],
    )
    return rows[0]
  }

  /** Undo an archive — bring the contact back into the book. Mirror of archive;
   *  backs the Archived view's "Restore" control. Undefined if not in location. */
  async restore(id: string): Promise<Contact | undefined> {
    const rows = await this.scopedWrite<Contact>(
      `UPDATE contacts SET archived_at = NULL, updated_at = now()
        WHERE location_id = $1 AND id = $2 RETURNING *`,
      [id],
    )
    return rows[0]
  }

  /** The archived contacts, newest-archived first — backs the Archived view so
   *  the operator can find and restore something they removed. */
  listArchived(limit = 200): Promise<Contact[]> {
    return this.scopedSelect<Contact>(
      'SELECT * FROM contacts WHERE archived_at IS NOT NULL ORDER BY archived_at DESC LIMIT $2',
      [limit],
    )
  }

  /** Append a tag, idempotently — a repeat tag is a no-op (no duplicate). Used by
   *  the automation runner's add_tag action. */
  async addTag(contactId: string, tag: string): Promise<Contact | undefined> {
    const rows = await this.scopedWrite<Contact>(
      `UPDATE contacts
          SET tags = CASE WHEN $2 = ANY(tags) THEN tags ELSE array_append(tags, $2) END,
              updated_at = now()
        WHERE location_id = $1 AND id = $3 RETURNING *`,
      [tag, contactId],
    )
    return rows[0]
  }

  /**
   * Set (or clear) the contact's US state — the per-state legal texting-hours
   * setting. Stores the 2-letter code; passing null clears it back to "not
   * set", which the gateway then refuses as unknown_state rather than guessing
   * a timezone. One statement for both (a plain column null is just state =
   * $2), mirroring archive/restore. Location-scoped; undefined if not in
   * location. The gateway is the legal authority, so this is a plain store —
   * no normalization here; legalTextWindow() normalizes on read.
   */
  async setState(id: string, state: string | null): Promise<Contact | undefined> {
    const rows = await this.scopedWrite<Contact>(
      `UPDATE contacts SET state = $2, updated_at = now()
        WHERE location_id = $1 AND id = $3 RETURNING *`,
      [state, id],
    )
    return rows[0]
  }

  /** Strip a tag from one contact, idempotently — removing an absent tag is a
   *  no-op. Mirror of addTag; backs the contact tag editor. */
  async removeTag(contactId: string, tag: string): Promise<Contact | undefined> {
    const rows = await this.scopedWrite<Contact>(
      `UPDATE contacts
          SET tags = array_remove(tags, $2),
              updated_at = now()
        WHERE location_id = $1 AND id = $3 RETURNING *`,
      [tag, contactId],
    )
    return rows[0]
  }

  /**
   * Set (or clear) one custom-field value on a contact, keyed by the field's
   * stable slug. A null value removes the key from the jsonb bag entirely (no
   * empty ghost values); any other value is merged under that key. Mirrors
   * addTag/removeTag — one value at a time, location-scoped.
   */
  async setCustomField(
    contactId: string,
    key: string,
    value: unknown,
  ): Promise<Contact | undefined> {
    if (value === null) {
      const rows = await this.scopedWrite<Contact>(
        `UPDATE contacts
            SET custom_fields = custom_fields - $2,
                updated_at = now()
          WHERE location_id = $1 AND id = $3 RETURNING *`,
        [key, contactId],
      )
      return rows[0]
    }
    const rows = await this.scopedWrite<Contact>(
      `UPDATE contacts
          SET custom_fields = custom_fields || jsonb_build_object($2::text, $3::jsonb),
              updated_at = now()
        WHERE location_id = $1 AND id = $4 RETURNING *`,
      [key, JSON.stringify(value), contactId],
    )
    return rows[0]
  }
}
