import { execFile } from 'node:child_process'

/**
 * R13-09 refusal contract: the rotate script must reject remote targets,
 * missing inputs, and weak passwords WITHOUT connecting anywhere. These run
 * without a database (spawn only). Success + dry-run behavior against
 * disposable PostgreSQL lives in rotate-op-password.pg.test.ts.
 */

function runRotate(env: Record<string, string>): Promise<{ code: number; out: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', 'scripts/rotate-op-password.ts'],
      { env: { ...process.env, ...env }, timeout: 60000 },
      (err, stdout, stderr) => {
        if (err && (err as { killed?: boolean }).killed) return reject(err)
        resolve({ code: (err as { code?: number } | null)?.code ?? 0, out: `${stdout}${stderr}` })
      },
    )
  })
}

test('R13-09: refuses a non-loopback target without connecting or leaking the URL', async () => {
  const { code, out } = await runRotate({
    DATABASE_URL: 'postgres://op:r13probe-fake-password@db.prod-neon.example.com:5432/appdb?sslmode=require',
    ROTATE_OPERATOR_ID: 'op_AL',
    ROTATE_NEW_PASSWORD: 'long-enough-fake-password',
  })
  expect(code).not.toBe(0)
  expect(out).toMatch(/non-local database/)
  expect(out).not.toContain('r13probe-fake-password')
  expect(out).not.toContain('db.prod-neon.example.com')
})

test('R13-09: refuses missing inputs and short passwords', async () => {
  const loopback = 'postgres://127.0.0.1:1/appdb?sslmode=disable'
  for (const [env, re] of [
    [{}, /DATABASE_URL required/],
    [{ DATABASE_URL: loopback }, /ROTATE_OPERATOR_ID required/],
    [{ DATABASE_URL: loopback, ROTATE_OPERATOR_ID: 'op_AL' }, /ROTATE_NEW_PASSWORD required/],
    [{ DATABASE_URL: loopback, ROTATE_OPERATOR_ID: 'op_AL', ROTATE_NEW_PASSWORD: 'short' }, /12\+ chars/],
  ] as Array<[Record<string, string>, RegExp]>) {
    const { code, out } = await runRotate(env)
    expect(code).not.toBe(0)
    expect(out).toMatch(re)
  }
})

test('R13-09: refuses a malformed database URL without crashing raw', async () => {
  const { code, out } = await runRotate({
    DATABASE_URL: 'not-a-url-at-all',
    ROTATE_OPERATOR_ID: 'op_AL',
    ROTATE_NEW_PASSWORD: 'long-enough-fake-password',
  })
  expect(code).not.toBe(0)
  // Either the URL parser or the loopback guard refuses; nothing connects.
  expect(out).toMatch(/non-local database|invalid|URL/i)
})
