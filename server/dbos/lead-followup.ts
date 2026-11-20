import { DBOS } from '@dbos-inc/dbos-sdk'
import type { Database } from '../db/database'
import { ContactsRepo } from '../repos/contacts-repo'
import { TimelineRepo } from '../repos/timeline-repo'

/**
 * Lead follow-up pilot workflow (ADR-002, G2/G5). The ONE DBOS workflow in
 * the tree: a durable, multi-day-capable customer follow-up that the custom
 * pg-boss wait machinery (N2/N3, disabled by default) cannot safely own.
 *
 * Determinism contract: the workflow body below branches only on recorded
 * step outputs. Every database read/write, clock use, and id generation
 * lives inside a named step. Inputs are identifiers + delay only — never
 * customer records, secrets, or provider credentials (payload discipline).
 *
 * The follow-up effect is SYNTHETIC (a timeline event + sink-style record):
 * the pilot must never send a real message. Its insert is idempotent on a
 * deterministic id, so DBOS's at-least-once step execution converges
 * instead of duplicating the business effect.
 */

export interface LeadFollowUpInput {
  locationId: string
  contactId: string
  /** Stable business-operation identity; seeds the workflow ID + effect keys. */
  operationId: string
  /** Durable sleep between eligibility checks (ms). */
  delayMs: number
}

export type LeadFollowUpOutcome =
  | { terminal: 'no-lead' }
  | { terminal: 'ineligible'; reason: string }
  | { terminal: 'lapsed'; reason: string }
  | { terminal: 'followed-up'; timelineId: string }

/** Stable workflow identity (G2): one business operation starts one workflow. */
export function leadFollowUpWorkflowId(input: Pick<LeadFollowUpInput, 'locationId' | 'operationId'>): string {
  return `lead-followup:${input.locationId}:${input.operationId}`
}

// The Database client cannot ride through workflow inputs (they must be
// JSON-serializable), so steps read it from module state set once by
// initLeadFollowUp before any workflow of this type starts.
let dbRef: Database | null = null

export function initLeadFollowUp(deps: { db: Database }): void {
  dbRef = deps.db
}

function db(): Database {
  if (!dbRef) throw new Error('lead follow-up used before initLeadFollowUp')
  return dbRef
}

interface LeadSnapshot {
  id: string
  archived: boolean
  hasChannel: boolean
}

async function loadLead(locationId: string, contactId: string): Promise<LeadSnapshot | null> {
  const contact = await new ContactsRepo(db(), locationId).get(contactId)
  if (!contact) return null
  return {
    id: contact.id,
    archived: contact.archived_at !== null && contact.archived_at !== undefined,
    hasChannel: (contact.emails?.length ?? 0) > 0 || (contact.phones?.length ?? 0) > 0,
  }
}

/** Pure eligibility rule on a recorded snapshot — safe in workflow control flow. */
function eligibilityOf(lead: LeadSnapshot): { eligible: boolean; reason: string } {
  if (lead.archived) return { eligible: false, reason: 'contact archived' }
  if (!lead.hasChannel) return { eligible: false, reason: 'no email or phone' }
  return { eligible: true, reason: 'ok' }
}

async function recordFollowUp(locationId: string, contactId: string, operationId: string): Promise<string> {
  const event = await new TimelineRepo(db(), locationId).addIdempotent({
    id: `followup:${locationId}:${operationId}`,
    contactId,
    type: 'followup_completed',
    refTable: 'contacts',
    refId: contactId,
    payload: { operationId, channel: 'synthetic', simulated: true },
  })
  return event.id
}

async function leadFollowUp(input: LeadFollowUpInput): Promise<LeadFollowUpOutcome> {
  const lead = await DBOS.runStep(() => loadLead(input.locationId, input.contactId), { name: 'load-lead' })
  if (!lead) return { terminal: 'no-lead' }
  const first = eligibilityOf(lead)
  if (!first.eligible) return { terminal: 'ineligible', reason: first.reason }

  await DBOS.sleep(input.delayMs)

  const again = await DBOS.runStep(() => loadLead(input.locationId, input.contactId), { name: 'recheck-lead' })
  if (!again) return { terminal: 'no-lead' }
  const second = eligibilityOf(again)
  if (!second.eligible) return { terminal: 'lapsed', reason: second.reason }

  const timelineId = await DBOS.runStep(() => recordFollowUp(input.locationId, input.contactId, input.operationId), {
    name: 'perform-followup',
  })
  return { terminal: 'followed-up', timelineId }
}

/** Registered at module import: import this module BEFORE DBOS.launch(). */
export const leadFollowUpWorkflow = DBOS.registerWorkflow(leadFollowUp)
