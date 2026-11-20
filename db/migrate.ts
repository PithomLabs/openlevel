import { readFileSync } from 'node:fs'
import { Pool } from 'pg'
import { assertLoopbackDatabaseUrl } from '../server/lib/db-identity'
import { collectEnvSecrets, formatSafeError } from '../server/lib/secrets'

const url = process.env.DATABASE_URL
if (!url) throw new Error('DATABASE_URL required')

const pool = new Pool({ connectionString: url })
try {
  // Local replay path only (dbmate owns releases): refuse remote targets
  // even when invoked directly, bypassing the Taskfile guard (Review 11 P2).
  assertLoopbackDatabaseUrl(url)
  const sql = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8')
  await pool.query(sql)
  console.log('openlevel: schema migrated')
} catch (err) {
  // Driver errors embed the connection string: scrub before stderr, and exit
  // nonzero so release_command fails the release on migration failure.
  console.error(formatSafeError(err, collectEnvSecrets(process.env)))
  process.exitCode = 1
} finally {
  await pool.end()
}
