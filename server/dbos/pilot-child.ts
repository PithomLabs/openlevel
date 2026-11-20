/**
 * Pilot kill-test worker (ADR-002). Launched as a CHILD PROCESS by the
 * SIGKILL test: starts one lead-follow-up workflow with a long sleep, prints
 * READY, then idles until the parent kills it. The parent relaunches the
 * SAME executor ID and proves recovery — a real process crash, not an
 * in-process shutdown.
 *
 * Env: PILOT_PG_URL, PILOT_LOCATION, PILOT_CONTACT, PILOT_OPERATION,
 * PILOT_DELAY_MS, PILOT_EXECUTOR, PILOT_VERSION.
 */
import { Pool } from 'pg'
import { PgDatabase } from '../db/database'
import { launchPilotDbos, startLeadFollowUp } from './pilot'

const need = (name: string): string => {
  const value = process.env[name]
  if (!value) throw new Error(`pilot-child: ${name} is required`)
  return value
}

const pool = new Pool({ connectionString: need('PILOT_PG_URL'), max: 4 })
const db = new PgDatabase(pool)
const input = {
  locationId: need('PILOT_LOCATION'),
  contactId: need('PILOT_CONTACT'),
  operationId: need('PILOT_OPERATION'),
  delayMs: Number(need('PILOT_DELAY_MS')),
}

await launchPilotDbos({
  systemDatabaseUrl: need('PILOT_PG_URL'),
  executorId: need('PILOT_EXECUTOR'),
  applicationVersion: need('PILOT_VERSION'),
  db,
})
const handle = await startLeadFollowUp(input)
console.log(`READY ${handle.workflowID}`)
setInterval(() => {}, 1000) // idle until SIGKILL; the sleep runs inside DBOS
