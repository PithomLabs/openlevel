/**
 * FIND-05 adoption gate against real PostgreSQL 18.7 (never PGlite: locking,
 * catalog rendering, and dbmate behavior are the points under test).
 * Runs via `task test:pg` (Docker-gated). Each test gets a fresh database.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { readFileSync } from 'node:fs'
import { inject } from 'vitest'
import { Pool } from 'pg'
import { PgDatabase } from '../server/db/database'
import { classifyAdoption } from './adopt-check'
import snapshotJson from './catalog-snapshot.json'
import type { SchemaCatalog } from './catalog'

const EXPECTED = snapshotJson as unknown as SchemaCatalog
const BASELINE = '20261119000000'

const baseUrl: string = inject('pgTestUrl') ?? process.env.OPENLEVEL_PG_TEST_URL ?? ''
if (baseUrl === '') throw new Error('pgTestUrl not provided — run via task test:pg')

function dbmateBin(): string | null {
  // A configured-but-missing binary must skip honestly, never fail spuriously
  // (/tmp installs evaporate; ~/.local/bin/dbmate is the stable local route).
  const configured = process.env.DBMATE_BIN
  if (configured) {
    try {
      accessSync(configured, constants.X_OK)
      return configured
    } catch {
      return null
    }
  }
  try {
    execFileSync('which', ['dbmate'], { stdio: 'ignore' })
    return 'dbmate'
  } catch {
    return null
  }
}

let dbCounter = 0
async function freshDb(): Promise<{ pool: Pool; url: string }> {
  const admin = new Pool({ connectionString: baseUrl.replace(/\/[^/]*$/, '/postgres') })
  const name = `adopt_${process.pid}_${dbCounter++}`
  try {
    await admin.query(`CREATE DATABASE "${name}"`)
  } finally {
    await admin.end()
  }
  // Testcontainers PG has no TLS (local-only): dbmate's Go driver requires
  // an explicit sslmode, unlike node-pg. Production/CI-service equivalents
  // always use the platform-appropriate mode (require on Neon).
  const url = `${baseUrl.replace(/\/[^/]*$/, `/${name}`)}?sslmode=disable`
  return { pool: new Pool({ connectionString: url }), url }
}

async function recordedVersions(pool: Pool): Promise<string[]> {
  try {
    const rows = await pool.query<{ version: string }>('SELECT version FROM schema_migrations ORDER BY version')
    return rows.rows.map((r) => r.version)
  } catch {
    return []
  }
}

const SCHEMA_SQL = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8')

describe('classifyAdoption on real PostgreSQL', () => {
  test('empty database proceeds as fresh', async () => {
    const { pool } = await freshDb()
    try {
      const verdict = await classifyAdoption(new PgDatabase(pool), EXPECTED, BASELINE)
      expect(verdict).toEqual({ decision: 'proceed', reason: 'empty-database' })
    } finally {
      await pool.end()
    }
  })

  test('compatible existing schema (no recorder yet) proceeds as adoption', async () => {
    const { pool } = await freshDb()
    try {
      await pool.query(SCHEMA_SQL)
      const verdict = await classifyAdoption(new PgDatabase(pool), EXPECTED, BASELINE)
      expect(verdict).toEqual({ decision: 'proceed', reason: 'compatible-schema' })
    } finally {
      await pool.end()
    }
  })

  test('pre-existing incomplete locations table refuses with missing branding (Review 11 exact case)', async () => {
    const { pool } = await freshDb()
    try {
      await pool.query('CREATE TABLE locations (id text PRIMARY KEY, name text NOT NULL)')
      const verdict = await classifyAdoption(new PgDatabase(pool), EXPECTED, BASELINE)
      expect(verdict.decision).toBe('refuse')
      if (verdict.decision === 'refuse') {
        expect(verdict.divergences).toContainEqual({ kind: 'missing-column', detail: 'locations.branding' })
      }
    } finally {
      await pool.end()
    }
  })

  test('dropped index and altered column type refuse', async () => {
    const { pool } = await freshDb()
    try {
      await pool.query(SCHEMA_SQL)
      await pool.query('DROP INDEX contacts_match_key')
      await pool.query('ALTER TABLE contacts ALTER COLUMN name TYPE varchar(10)')
      const verdict = await classifyAdoption(new PgDatabase(pool), EXPECTED, BASELINE)
      expect(verdict.decision).toBe('refuse')
      if (verdict.decision === 'refuse') {
        const kinds = verdict.divergences.map((d) => d.kind)
        expect(kinds).toContain('missing-index')
        expect(kinds).toContain('column-mismatch')
      }
    } finally {
      await pool.end()
    }
  })
})

const DBMATE = dbmateBin()

describe.skipIf(!DBMATE)('migrate-release orchestrator (needs dbmate binary)', () => {
  function runRelease(url: string): { status: number | null; out: string } {
    const res = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'db/migrate-release.ts'],
      { env: { ...process.env, DATABASE_URL: url, DBMATE_BIN: DBMATE as string }, encoding: 'utf8', timeout: 120000 },
    )
    return { status: res.status, out: `${res.stdout ?? ''}\n${res.stderr ?? ''}` }
  }

  test('fresh database migrates, records baseline, re-applies cleanly, data survives', async () => {
    const { pool, url } = await freshDb()
    try {
      const first = runRelease(url)
      expect(first.status).toBe(0)
      expect(first.out).toMatch(/adoption check passed \(empty-database\)/)
      expect(await recordedVersions(pool)).toEqual([BASELINE, '20261119130000', '20261119140000', '20261119150000', '20261119160000'])
      await pool.query("INSERT INTO locations (id, name, slug) VALUES ('canary', 'Canary', 'canary')")
      const second = runRelease(url)
      expect(second.status).toBe(0)
      expect(second.out).toMatch(/adoption check passed \(baseline-recorded\)/)
      const found = await pool.query("SELECT id FROM locations WHERE id = 'canary'")
      expect(found.rows).toHaveLength(1)
    } finally {
      await pool.end()
    }
  })

  test('divergent database refuses BEFORE anything is recorded (G2)', async () => {
    const { pool, url } = await freshDb()
    try {
      // Review 11's exact wound on top of a full schema: everything present
      // except the branding column, so the refusal names it precisely.
      await pool.query(SCHEMA_SQL)
      await pool.query('ALTER TABLE locations DROP COLUMN branding')
      const r = runRelease(url)
      expect(r.status).not.toBe(0)
      expect(r.out).toMatch(/refusing migration/)
      expect(r.out).toMatch(/missing-column: locations\.branding/)
      expect(await recordedVersions(pool)).toEqual([])
    } finally {
      await pool.end()
    }
  })

  test('concurrent releases serialize: exactly-once apply, both exit 0 (G2)', async () => {
    const { pool, url } = await freshDb()
    try {
      const { spawn } = await import('node:child_process')
      const one = () =>
        new Promise<{ status: number | null }>((resolve) => {
          const child = spawn(process.execPath, ['--import', 'tsx', 'db/migrate-release.ts'], {
            env: { ...process.env, DATABASE_URL: url, DBMATE_BIN: DBMATE as string },
            stdio: 'ignore',
          })
          child.on('close', (status) => resolve({ status }))
        })
      const [a, b] = await Promise.all([one(), one()])
      expect(a.status).toBe(0)
      expect(b.status).toBe(0)
      expect(await recordedVersions(pool)).toEqual([BASELINE, '20261119130000', '20261119140000', '20261119150000', '20261119160000'])
      const tables = await pool.query('SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = \'public\'')
      expect(tables.rows[0]?.n).toBeGreaterThan(50)
    } finally {
      await pool.end()
    }
  })

  test('dbmate failure propagates a nonzero exit and records nothing', async () => {
    const admin = new Pool({ connectionString: baseUrl.replace(/\/[^/]*$/, '/postgres') })
    const name = `adopt_nopriv_${process.pid}`
    try {
      await admin.query(`CREATE DATABASE "${name}"`)
      await admin.query(`CREATE ROLE nopriv_${process.pid} LOGIN PASSWORD 'x'`)
      await admin.query(`REVOKE CREATE ON DATABASE "${name}" FROM PUBLIC`)
      // Fresh DB, unprivileged user: adoption passes (empty), dbmate must fail.
      const url =
        baseUrl.replace(/\/[^/]*$/, `/${name}`).replace(/:\/\/[^@]+@/, `://nopriv_${process.pid}:x@`) +
        '?sslmode=disable'
      const { Pool: P2 } = await import('pg')
      const probe = new P2({ connectionString: url })
      let versions: string[] = []
      try {
        versions = await recordedVersions(probe)
      } catch {
        versions = []
      } finally {
        await probe.end()
      }
      expect(versions).toEqual([])
      const r = runRelease(url)
      expect(r.status).not.toBe(0)
      expect(r.out).toMatch(/adoption check passed \(empty-database\)/)
      expect(r.out).toMatch(/permission denied/i)
    } finally {
      // Best-effort cleanup outside the test database (admin on postgres db).
      await admin.query(`DROP DATABASE IF EXISTS "${name}"`).catch(() => {})
      await admin.query(`DROP ROLE IF EXISTS nopriv_${process.pid}`).catch(() => {})
      await admin.end()
    }
  })

  test('interrupted release retries cleanly: SIGKILL mid-run, re-run exits 0 fully applied (§11)', async () => {
    const { pool, url } = await freshDb()
    try {
      const { spawn } = await import('node:child_process')
      const child = spawn(process.execPath, ['--import', 'tsx', 'db/migrate-release.ts'], {
        env: { ...process.env, DATABASE_URL: url, DBMATE_BIN: DBMATE as string },
        stdio: 'ignore',
      })
      // Kill mid-run regardless of phase (adoption, lock-hold, or dbmate):
      // the session lock dies with the connection and nothing half-records.
      await new Promise((r) => setTimeout(r, 2500))
      child.kill('SIGKILL')
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve()
        child.on('exit', () => resolve())
      })
      const retry = runRelease(url)
      expect(retry.status).toBe(0)
      expect(await recordedVersions(pool)).toEqual([BASELINE, '20261119130000', '20261119140000', '20261119150000', '20261119160000'])
      const sink = await pool.query('SELECT to_regclass($1) AS oid', ['public.outbound_sink'])
      expect(sink.rows[0]?.oid).not.toBeNull()
    } finally {
      await pool.end()
    }
  }, 120000)
})
