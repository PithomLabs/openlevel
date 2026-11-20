import { DBOS, type WorkflowHandle } from '@dbos-inc/dbos-sdk'
import { GlobalLogger } from '@dbos-inc/dbos-sdk/internal/telemetry/logs'
import { migrateSystemDatabase } from '@dbos-inc/dbos-sdk/internal/system_database'
import type { Database } from '../db/database'
import { ContactsRepo } from '../repos/contacts-repo'
import { OutboxRepo } from '../repos/outbox-repo'
import {
  initLeadFollowUp,
  leadFollowUpWorkflow,
  leadFollowUpWorkflowId,
  type LeadFollowUpInput,
  type LeadFollowUpOutcome,
} from './lead-followup'

/**
 * DBOS pilot harness (ADR-002). Launch/shutdown, schema migration, workflow
 * start, and the transactional handoff command. Used by pilot tests and the
 * pilot runner ONLY — production bootstrap does not launch DBOS.
 *
 * Import order matters: importing `./lead-followup` registers the workflow;
 * registration must happen before launch so recovery finds its definition.
 */

export const DBOS_SCHEMA = 'dbos'
export const DBOS_APP = 'openlevel-pilot'

export interface PilotLaunchOpts {
  /** System-database URL (same PG cluster, `dbos` schema). */
  systemDatabaseUrl: string
  /** Stable executor identity: a relaunch with the same ID recovers its own workflows. */
  executorId: string
  /** Application version: recovery refuses silently-mismatched definitions. */
  applicationVersion: string
  /** Application database handle for workflow steps (module state). */
  db: Database
}

/** Create/migrate the DBOS system schema (privileged step; tests run it per database). */
export async function migratePilotSchema(systemDatabaseUrl: string): Promise<void> {
  await migrateSystemDatabase(systemDatabaseUrl, new GlobalLogger(), DBOS_SCHEMA)
}

export async function launchPilotDbos(opts: PilotLaunchOpts): Promise<void> {
  initLeadFollowUp({ db: opts.db })
  DBOS.setConfig({
    name: DBOS_APP,
    systemDatabaseUrl: opts.systemDatabaseUrl,
    systemDatabaseSchemaName: DBOS_SCHEMA,
    executorID: opts.executorId,
    applicationVersion: opts.applicationVersion,
  })
  await DBOS.launch()
}

export async function shutdownPilotDbos(): Promise<void> {
  await DBOS.shutdown()
}

/**
 * Start (or attach to) the follow-up workflow for one business operation.
 * `return-existing` makes the stable workflow ID an idempotency key:
 * duplicate starts collapse onto the one execution instead of forking it.
 */
export async function startLeadFollowUp(
  input: LeadFollowUpInput,
): Promise<WorkflowHandle<LeadFollowUpOutcome>> {
  return DBOS.startWorkflow(leadFollowUpWorkflow, {
    workflowID: leadFollowUpWorkflowId(input),
    workflowIDReusePolicy: 'return-existing',
  })(input)
}

export interface LeadFollowUpIntent {
  contactId: string
  operationId: string
  delayMs: number
}

/**
 * Request follow-up for a lead, durably handed off: the contact check and
 * the outbox intent commit in ONE business transaction, so the intent can
 * never exist without its lead (and the relay's stable-ID start makes
 * redelivery safe). Throws when the contact does not exist.
 */
export async function requestLeadFollowUp(
  db: Database,
  locationId: string,
  intent: LeadFollowUpIntent,
): Promise<void> {
  await db.withTransaction(async (tx) => {
    const contact = await new ContactsRepo(tx, locationId).get(intent.contactId)
    if (!contact) throw new Error(`lead follow-up refused: no contact ${intent.contactId}`)
    await new OutboxRepo(tx, locationId).insert({
      id: `dbos:lead-followup:${locationId}:${intent.operationId}`,
      aggregate: 'dbos_workflow',
      aggregateId: intent.operationId,
      event: 'dbos.lead-followup.start',
      payload: { contactId: intent.contactId, operationId: intent.operationId, delayMs: intent.delayMs },
    })
  })
}
