import { vi } from 'vitest'
import {
  REDACTED,
  SECRET_ENV_VARS,
  collectEnvSecrets,
  formatSafeError,
  redactAll,
  redactText,
  redactUrl,
  reportError,
  safeError,
} from './secrets'

// Canaries: obviously fake, unguessable-shaped values. If any of these ever
// appears in output, the scrubber failed — the test fails, not the deploy.
const CANARY_URL = 'postgres://op:CANARY_PW_9z7x@db.internal:5432/app?sslmode=require'
const CANARY_SESSION = 'CANARY_SESSION_k3j8s7d6f5g4h3j2k1l0m9n8b7v6c5x4z'
const CANARY_TOKEN = 'CANARY_TOKEN_qw1er2ty3ui4op5as6df7gh8jk9lz0xc'

test('SECRET_ENV_VARS names the five static secrets (values never listed)', () => {
  expect([...SECRET_ENV_VARS]).toEqual([
    'DATABASE_URL',
    'SESSION_SECRET',
    'CHATWOOT_WEBHOOK_SECRET',
    'FEDERATION_SERVICE_TOKEN',
    'INTERNAL_PUSH_SECRET',
  ])
})

test('collectEnvSecrets gathers set values only, memory-only', () => {
  expect(collectEnvSecrets({ DATABASE_URL: CANARY_URL, SESSION_SECRET: '', OTHER: 'x' })).toEqual([CANARY_URL])
  expect(collectEnvSecrets({})).toEqual([])
})

test('redactText replaces canary values and leaves the rest', () => {
  const out = redactText(`booting with ${CANARY_SESSION} on port 8790`, [CANARY_SESSION, undefined, null, ''])
  expect(out).toBe(`booting with ${REDACTED} on port 8790`)
})

test('redactText scrubs longest-first so nested secrets vanish fully', () => {
  const out = redactText(`url=${CANARY_URL}`, [CANARY_URL, 'CANARY_PW_9z7x'])
  expect(out).not.toContain('CANARY')
  expect(out).toBe(`url=${REDACTED}`)
})

test('redactUrl masks the password but keeps the URL shape for debugging', () => {
  expect(redactUrl(`connect ${CANARY_URL} failed`)).toBe(
    'connect postgres://op:****@db.internal:5432/app?sslmode=require failed',
  )
  expect(redactUrl('no url here')).toBe('no url here')
  expect(redactUrl('postgres://user@host/db (no password)')).toBe('postgres://user@host/db (no password)')
})

test('redactAll catches an unlisted secret when it sits in a URL', () => {
  // A per-client vault key the caller forgot to pass: structural masking
  // still hides the password.
  const out = redactAll(`dial postgres://svc:${CANARY_TOKEN}@h:5432/d`, [])
  expect(out).not.toContain(CANARY_TOKEN)
  expect(out).toContain('postgres://svc:****@h:5432/d')
})

test('safeError serializes name+message+stack with every canary scrubbed', () => {
  const err = new Error(`connect ${CANARY_URL} with ${CANARY_SESSION} refused`)
  err.stack = `Error: connect ${CANARY_URL}\n    at boot (server/index.ts:1:1)`
  const safe = safeError(err, [CANARY_URL, CANARY_SESSION])
  expect(safe.name).toBe('Error')
  expect(safe.message).not.toContain('CANARY')
  expect(safe.message).toContain(REDACTED)
  expect(safe.stack).not.toContain('CANARY')
  expect(safe.stack).toContain('server/index.ts')
})

test('safeError drops bespoke fields that smuggle connection strings', () => {
  const err = Object.assign(new Error('boom'), { connectionString: CANARY_URL, password: CANARY_TOKEN })
  const safe = safeError(err, [])
  // URL-structure scrubbing is the backstop even with no secret list.
  expect(JSON.stringify(safe)).not.toContain('CANARY_PW_9z7x')
})

test('safeError handles non-Error throws without leaking', () => {
  expect(safeError(`string throw ${CANARY_TOKEN}`, [CANARY_TOKEN]).message).toBe(`string throw ${REDACTED}`)
  expect(safeError(undefined).message).toBe('undefined')
})

test('formatSafeError renders one clean log line', () => {
  expect(formatSafeError(new Error(`bad ${CANARY_TOKEN}`), [CANARY_TOKEN])).toBe(`Error: bad ${REDACTED}`)
})

test('safeError scrubs nested cause chains (FIND-01)', () => {
  const inner = new Error(`provider refused ${CANARY_URL}`)
  const outer = new Error('booking failed', { cause: inner })
  const safe = safeError(outer, [CANARY_URL])
  expect(safe.cause?.message).not.toContain('CANARY')
  expect(safe.cause?.message).toContain(REDACTED)
  expect(JSON.stringify(safe)).not.toContain('CANARY_PW_9z7x')
  // Classification survives scrubbing.
  expect(safe.message).toContain('booking failed')
})

test('safeError survives cause cycles and deep chains (FIND-01)', () => {
  const a = new Error('a') as Error & { cause?: unknown }
  const b = new Error('b', { cause: a })
  a.cause = b // cycle: a -> b -> a
  expect(() => safeError(a, [])).not.toThrow()
  let deep: Error = new Error('leaf')
  for (let i = 0; i < 20; i++) deep = new Error(`level${i}`, { cause: deep })
  const safe = safeError(deep, [])
  let levels = 0
  for (let c = safe.cause; c !== undefined; c = c.cause) levels += 1
  expect(levels).toBeLessThanOrEqual(5)
})

test('reportError includes the environment in its tag when APP_ENV is set (Review 11 P3)', () => {
  const lines: string[] = []
  const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '))
  })
  const prior = process.env.APP_ENV
  process.env.APP_ENV = 'staging'
  try {
    reportError('boot', new Error('nope'), [])
  } finally {
    spy.mockRestore()
    if (prior === undefined) delete process.env.APP_ENV
    else process.env.APP_ENV = prior
  }
  expect(lines[0]).toMatch(/^\[boot env=staging\] Error: /)
})

test('reportError emits source-tagged scrubbed lines, never the raw object (FIND-01)', () => {
  const lines: string[] = []
  const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '))
  })
  try {
    reportError('http GET /api/loc/x/contacts', new Error(`query failed ${CANARY_URL}`), [CANARY_URL])
  } finally {
    spy.mockRestore()
  }
  expect(lines.length).toBeGreaterThanOrEqual(1)
  expect(lines[0]).toMatch(/^\[http GET \/api\/loc\/x\/contacts\] Error: /)
  expect(lines.join('\n')).not.toContain('CANARY')
  expect(lines.join('\n')).toContain(REDACTED)
})
