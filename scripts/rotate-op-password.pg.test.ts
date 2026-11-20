/**
 * R13-09 success paths on disposable PostgreSQL: dry-run validates without
 * writing; a real run rotates exactly one operator's hash. Runs via
 * `task test:pg` only — never against a shared or remote database (the
 * script itself refuses non-loopback targets).
 */
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { inject } from 'vitest'
import { Pool } from 'pg'

const baseUrl: string = inject('pgTestUrl') ?? process.env.OPENLEVEL_PG_TEST_URL ?? ''
if (baseUrl === '') throw new Error('pgTestUrl not provided — run via task test:pg')

const SCHEMA = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8')

beforeAll(async () => {
  const pool = new Pool({ connectionString: baseUrl })
  try {
    await pool.query(SCHEMA)
  } finally {
    await pool.end()
  }
})

function runRotate(env: Record<string, string>): Promise<{ code: number; out: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', 'scripts/rotate-op-password.ts'],
      { env: { ...process.env, ...env }, timeout: 90000 },
      (err, stdout, stderr) => {
        if (err && (err as { killed?: boolean }).killed) return reject(err)
        resolve({ code: (err as { code?: number } | null)?.code ?? 0, out: `${stdout}${stderr}` })
      },
    )
  })
}

test('R13-09 on real PG: dry-run validates without writing; real run rotates exactly one hash', async () => {
  const pool = new Pool({ connectionString: baseUrl })
  try {
    const opId = `op_rot_${process.pid}`
    await pool.query(`INSERT INTO operators (id, email, role, password_hash) VALUES ($1, 'rot@example.com', 'owner', 'old-hash')`, [opId])
    const base = { DATABASE_URL: baseUrl, ROTATE_OPERATOR_ID: opId }

    const dry = await runRotate({ ...base, ROTATE_NEW_PASSWORD: 'dry-run-fake-password-1', ROTATE_DRY_RUN: '1' })
    expect(dry.code).toBe(0)
    expect(dry.out).toMatch(/dry run: would rotate/)
    expect(dry.out).not.toContain('dry-run-fake-password-1')
    const unmoved = await pool.query<{ password_hash: string }>('SELECT password_hash FROM operators WHERE id = $1', [opId])
    expect(unmoved.rows[0]?.password_hash).toBe('old-hash')

    const real = await runRotate({ ...base, ROTATE_NEW_PASSWORD: 'real-fake-password-000000' })
    expect(real.code).toBe(0)
    expect(real.out).toMatch(new RegExp(`rotated password for ${opId}`))
    expect(real.out).not.toContain('real-fake-password-000000')
    const moved = await pool.query<{ password_hash: string }>('SELECT password_hash FROM operators WHERE id = $1', [opId])
    expect(moved.rows[0]?.password_hash).not.toBe('old-hash')

    const missing = await runRotate({ DATABASE_URL: baseUrl, ROTATE_OPERATOR_ID: 'op_nope', ROTATE_NEW_PASSWORD: 'x'.repeat(12) })
    expect(missing.code).not.toBe(0)
    expect(missing.out).toMatch(/not found/)
  } finally {
    await pool.end()
  }
})
