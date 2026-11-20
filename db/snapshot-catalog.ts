/**
 * Generate db/catalog-snapshot.json from a freshly dbmate-migrated database.
 *
 *   DATABASE_URL=... npm run db:snapshot
 *
 * The snapshot is a COMMITTED contract: CI regenerates it from a fresh
 * ephemeral apply and diffs against the committed file, so any migration
 * that changes the schema without refreshing the snapshot fails loudly.
 * Local URLs only (same loopback rule as the other one-off scripts).
 * SNAPSHOT_OUT overrides the output path (CI drift check writes to temp).
 */
import { writeFileSync } from 'node:fs'
import { Pool } from 'pg'
import { assertLoopbackDatabaseUrl } from '../server/lib/db-identity'
import { PgDatabase } from '../server/db/database'
import { collectEnvSecrets, formatSafeError } from '../server/lib/secrets'
import { dumpCatalog } from './catalog'

const url = process.env.DATABASE_URL
if (!url) throw new Error('DATABASE_URL required')

const pool = new Pool({ connectionString: url })
try {
  assertLoopbackDatabaseUrl(url)
  const catalog = await dumpCatalog(new PgDatabase(pool))
  const override = process.env.SNAPSHOT_OUT ?? ''
  const out = override !== '' ? override : new URL('./catalog-snapshot.json', import.meta.url)
  writeFileSync(out, `${JSON.stringify(catalog, null, 2)}\n`)
  const tables = Object.keys(catalog.tables).length
  const columns = Object.values(catalog.tables).reduce((n, t) => n + Object.keys(t.columns).length, 0)
  console.log(`openlevel: snapshot written (pg${catalog.pgMajor}, ${tables} tables, ${columns} columns, ${catalog.indexes.length} indexes)`)
} catch (err) {
  console.error(formatSafeError(err, collectEnvSecrets(process.env)))
  process.exitCode = 1
} finally {
  await pool.end()
}
