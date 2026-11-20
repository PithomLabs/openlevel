/**
 * §11 evidence anchor: the real-PostgreSQL suite must prove the SERVER it ran
 * against, not merely the image tag that was requested.
 */
import { inject } from 'vitest'
import { Pool } from 'pg'

const baseUrl: string = inject('pgTestUrl') ?? process.env.OPENLEVEL_PG_TEST_URL ?? ''
if (baseUrl === '') throw new Error('pgTestUrl not provided — run via task test:pg')

test('pg suite runs against PostgreSQL 18.7 (server-reported)', async () => {
  const pool = new Pool({ connectionString: baseUrl })
  try {
    const rows = await pool.query<{ version: string }>('SELECT version() AS version')
    expect(rows.rows[0]?.version).toMatch(/PostgreSQL 18\.7/)
  } finally {
    await pool.end()
  }
})
