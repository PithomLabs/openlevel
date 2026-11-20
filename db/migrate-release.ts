/**
 * Release migration orchestrator (FIND-05, G2): `npm run db:migrate:release`.
 *
 * Runs the identity gate, adoption gate, and dbmate as one fail-closed unit:
 *
 *   0. Enforce the SAME APP_ENV/app/DB identity invariant the boot path
 *      uses (N1: resolveAppEnv + assertEnvDatabaseIdentity) — but not the
 *      app's secret posture, which a migration runner must not require
 *      (the CI release-equivalent runs secrets-free). A release pointed at
 *      the wrong database refuses BEFORE opening any connection.
 *   1. Take a session-level advisory lock (60s lock_timeout, fail closed).
 *      Concurrent releases serialize here instead of racing the baseline.
 *   2. Run the adoption check on the target. Divergent -> release the lock
 *      and exit nonzero BEFORE dbmate records anything.
 *   3. Spawn dbmate (its own connections; our session holds the lock across
 *      it) and propagate its exit code: migration failure fails the release.
 *
 * Raw `dbmate` invoked outside this orchestrator does not take the adoption
 * lock — supported only for local/CI inspection, never for shared envs.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { Pool } from 'pg'
import { PgDatabase } from '../server/db/database'
import { assertEnvDatabaseIdentity, resolveAppEnv } from '../server/lib/db-identity'
import { collectEnvSecrets, formatSafeError } from '../server/lib/secrets'
import { type SchemaCatalog } from './catalog'
import { classifyAdoption, formatDivergences } from './adopt-check'

const BASELINE_VERSION = '20261119000000'
const LOCK_NAME = 'openlevel-migrate-v1'
const LOCK_TIMEOUT_MS = 60_000
const DBMATE_BIN = process.env.DBMATE_BIN ?? 'dbmate'

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

const url = process.env.DATABASE_URL
if (!url) fail('DATABASE_URL required')

// N1: the release enforces the SAME env/app/DB identity invariant as the
// boot path (resolve + cross-check), but NOT the app's secret posture — a
// migration runner must refuse the wrong database, not demand web secrets.
// Either failure refuses BEFORE any connection is opened. R14-11: a remote
// target without a named APP_ENV refuses (resolveAppEnv); loopback keeps
// the default for local/CI inspection runs.
try {
  assertEnvDatabaseIdentity({
    appEnv: resolveAppEnv(process.env.APP_ENV, { databaseUrl: url }),
    databaseUrl: url,
    flyAppName: process.env.FLY_APP_NAME,
    expectedDbHost: process.env.EXPECTED_DB_HOST,
  })
} catch (err) {
  fail(err instanceof Error ? err.message : String(err))
}

let expected: SchemaCatalog
try {
  expected = JSON.parse(readFileSync(new URL('./catalog-snapshot.json', import.meta.url), 'utf8')) as SchemaCatalog
} catch {
  fail('db/catalog-snapshot.json missing or invalid — run npm run db:snapshot against a fresh migrated database')
}

const pool = new Pool({ connectionString: url })
const holder = await pool.connect()
try {
  await holder.query(`SET lock_timeout = '${LOCK_TIMEOUT_MS}ms'`)
  try {
    await holder.query(`SELECT pg_advisory_lock(hashtext($1)::bigint)`, [LOCK_NAME])
  } catch (err) {
    fail(
      `migration lock not acquired within ${LOCK_TIMEOUT_MS / 1000}s (another release is migrating?) — ${formatSafeError(err, collectEnvSecrets(process.env))}`,
    )
  }
  const verdict = await classifyAdoption(new PgDatabase(pool), expected, BASELINE_VERSION)
  if (verdict.decision === 'refuse') {
    console.error('refusing migration: target schema diverges from the baseline contract:')
    for (const line of formatDivergences(verdict.divergences).slice(0, 25)) console.error(`  - ${line}`)
    if (verdict.divergences.length > 25) console.error(`  ... and ${verdict.divergences.length - 25} more`)
    process.exit(1)
  }
  console.log(`openlevel: adoption check passed (${verdict.reason}); running dbmate`)
  const res = spawnSync(DBMATE_BIN, ['--no-dump-schema', '--migrations-dir', './db/migrations', 'migrate'], {
    env: process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  // dbmate logs Applying:/Applied: lines only, but scrub defensively: the
  // release log must never carry credentials even if dbmate ever echoes more.
  const secrets = collectEnvSecrets(process.env)
  const { redactAll } = await import('../server/lib/secrets')
  if (res.stdout) process.stdout.write(redactAll(res.stdout, secrets))
  if (res.error) {
    fail(`dbmate executable not found (${DBMATE_BIN}): ${res.error.message}`)
  }
  if (res.stderr) process.stderr.write(redactAll(res.stderr, secrets))
  if (res.status !== 0) {
    fail(`dbmate migrate failed with exit ${res.status ?? 'unknown'} — release fails closed`)
  }
  console.log('openlevel: release migration complete')
} catch (err) {
  console.error(formatSafeError(err, collectEnvSecrets(process.env)))
  process.exitCode = 1
} finally {
  try {
    await holder.query(`SELECT pg_advisory_unlock(hashtext($1)::bigint)`, [LOCK_NAME])
  } catch {
    // Unlock failure on a dying connection is harmless: session-level locks
    // release automatically when the holder disconnects.
  }
  holder.release()
  await pool.end()
}
