import { execFile } from 'node:child_process'
import { createServer } from 'node:net'

/**
 * N1 regression: the release migration orchestrator must enforce the same
 * environment/database identity invariant as the boot path, BEFORE opening
 * any connection. Spawns the real script so the test covers wiring, not just
 * the identity function (which has its own 11-case unit matrix).
 */

function runRelease(
  env: Record<string, string>,
  timeoutMs = 45000,
): Promise<{ code: number; out: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', 'db/migrate-release.ts'],
      { env: { ...process.env, ...env }, timeout: timeoutMs },
      (err, stdout, stderr) => {
        if (err && (err as { killed?: boolean }).killed) {
          return reject(new Error(`release orchestrator hung and was killed: ${stdout}${stderr}`))
        }
        resolve({ code: (err as { code?: number } | null)?.code ?? 0, out: `${stdout}${stderr}` })
      },
    )
  })
}

/** A port that is (almost surely) closed: bind, read, release. */
function closedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') return reject(new Error('no address'))
      const port = address.port
      server.close(() => resolve(port))
    })
  })
}

const STAGING_SECRETS = {
  SESSION_SECRET: 'n1probe-session-secret-fake-0000000000',
  CHATWOOT_WEBHOOK_SECRET: 'n1probe-webhook-secret-fake-0000000000',
}

test('N1: staging identity pointed at a prod hostname refuses without connecting', async () => {
  const { code, out } = await runRelease({
    APP_ENV: 'staging',
    FLY_APP_NAME: 'openlevel-staging',
    EXPECTED_DB_HOST: 'db.staging-neon.invalid',
    DATABASE_URL: 'postgres://n1probe:n1probe-fake-password-000@db.prod-neon.invalid:5432/appdb?sslmode=require',
    ...STAGING_SECRETS,
  })
  expect(code).not.toBe(0)
  // Identity refusal, not a connection error: nothing was dialed.
  expect(out).toMatch(/contradicts APP_ENV|requires EXPECTED_DB_HOST/)
  expect(out).not.toMatch(/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|connect /)
  // No migration ran and no credential material leaked into the log.
  expect(out).not.toMatch(/Applying:|Applied:/)
  expect(out).not.toContain('db.prod-neon.invalid')
  expect(out).not.toContain('n1probe-fake-password-000')
  expect(out).not.toContain('n1probe-session-secret')
})

test('N1: platform identity contradiction (R1) refuses before connecting', async () => {
  const { code, out } = await runRelease({
    APP_ENV: 'staging',
    FLY_APP_NAME: 'openlevel-prod',
    DATABASE_URL: 'postgres://127.0.0.1:1/appdb?sslmode=disable',
    ...STAGING_SECRETS,
  })
  expect(code).not.toBe(0)
  expect(out).toMatch(/FLY_APP_NAME .* contradicts APP_ENV=staging/)
  expect(out).not.toMatch(/Applying:|Applied:/)
})

test('N1: valid loopback config passes identity and attempts the connection', async () => {
  const port = await closedPort()
  const { code, out } = await runRelease({
    APP_ENV: 'development',
    DATABASE_URL: `postgres://127.0.0.1:${port}/appdb?sslmode=disable`,
  })
  expect(code).not.toBe(0)
  // Past identity (it dialed), failed on the closed port — the honest signal.
  expect(out).toMatch(/ECONNREFUSED|connect/)
  expect(out).not.toMatch(/contradicts|EXPECTED_DB_HOST|unknown APP_ENV/)
})

test('N1: missing DATABASE_URL still fails fast with no connection', async () => {
  const { code, out } = await runRelease({ APP_ENV: 'development', DATABASE_URL: '' })
  expect(code).not.toBe(0)
  expect(out).toMatch(/DATABASE_URL required/)
})

test('R14-11: remote target without a named APP_ENV refuses before connecting (same contract as boot)', async () => {
  const env: Record<string, string> = {
    DATABASE_URL: 'postgres://n1probe:n1probe-fake-password-000@db.staging-neon.invalid:5432/appdb?sslmode=require',
    EXPECTED_DB_HOST: 'db.staging-neon.invalid',
  }
  delete process.env.APP_ENV // ensure unset even if the runner exports it
  const { code, out } = await runRelease(env)
  expect(code).not.toBe(0)
  expect(out).toMatch(/APP_ENV must be set explicitly/)
  expect(out).not.toMatch(/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|connect /)
  expect(out).not.toContain('db.staging-neon.invalid')
  expect(out).not.toContain('n1probe-fake-password-000')
})
