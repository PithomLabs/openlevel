/**
 * One-off ops tool: rotate an operator's password in place.
 * The seed hardcodes a demo password; this replaces it before the app is
 * exposed on a public URL. Inputs come from env (never argv — argv leaks
 * into `ps` output and shell history on the host):
 *
 *   ROTATE_OPERATOR_ID=op_AL ROTATE_NEW_PASSWORD='...' npx tsx scripts/rotate-op-password.ts
 *
 * Safety posture (R13-09):
 * - LOOPBACK ONLY: refuses any non-loopback DATABASE_URL — Neon, remote,
 *   and production hosts are never valid targets for this script. There is
 *   no remote mode; production rotation is a documented owner procedure.
 * - DRY RUN: ROTATE_DRY_RUN=1 validates everything, connects, confirms the
 *   operator exists, and prints what would happen — without writing.
 * - Errors are credential-scrubbed: pg driver errors embed the connection
 *   string, so every failure path runs through formatSafeError.
 *
 * Refuses passwords under 12 chars. Prints the operator id/email on success,
 * never the password.
 */
import { Pool } from 'pg'
import { assertLoopbackDatabaseUrl } from '../server/lib/db-identity'
import { collectEnvSecrets, formatSafeError } from '../server/lib/secrets'
import { hashPassword } from '../server/lib/password'

const url = process.env.DATABASE_URL
const operatorId = process.env.ROTATE_OPERATOR_ID
const newPassword = process.env.ROTATE_NEW_PASSWORD
const dryRun = process.env.ROTATE_DRY_RUN === '1'

if (!url) throw new Error('DATABASE_URL required')
assertLoopbackDatabaseUrl(url)
if (!operatorId) throw new Error('ROTATE_OPERATOR_ID required')
if (!newPassword || newPassword.length < 12) {
  throw new Error('ROTATE_NEW_PASSWORD required (12+ chars)')
}

const pool = new Pool({ connectionString: url })
try {
  if (dryRun) {
    const found = await pool.query<{ email: string }>('SELECT email FROM operators WHERE id = $1', [operatorId])
    if (found.rowCount !== 1) throw new Error(`operator ${operatorId} not found — nothing to rotate`)
    console.log(`dry run: would rotate password for ${operatorId} (${found.rows[0].email}); no changes made`)
  } else {
    const hash = await hashPassword(newPassword)
    const res = await pool.query<{ email: string }>(
      `UPDATE operators SET password_hash = $1 WHERE id = $2 RETURNING email`,
      [hash, operatorId],
    )
    if (res.rowCount !== 1) {
      throw new Error(`operator ${operatorId} not found — nothing rotated`)
    }
    console.log(`rotated password for ${operatorId} (${res.rows[0].email})`)
  }
} catch (err) {
  console.error(`rotate-op-password: ${formatSafeError(err, collectEnvSecrets(process.env))}`)
  process.exitCode = 1
} finally {
  await pool.end()
}
