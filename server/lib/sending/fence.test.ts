import { FenceRefusal, assertSinkRecipient, stagingFenceFromEnv } from './fence'

test('non-staging environments are unaffected by the fence', () => {
  for (const appEnv of [undefined, '', 'development', 'production']) {
    const fence = stagingFenceFromEnv({ APP_ENV: appEnv })
    expect(fence.sink).toBe(false)
    expect(() => assertSinkRecipient(fence, 'anyone@example.com')).not.toThrow()
  }
})

test('staging parses the allowlist (trimmed, lowercased, empties dropped)', () => {
  const fence = stagingFenceFromEnv({
    APP_ENV: 'staging',
    STAGING_SINK_ALLOWLIST: '  Alice@Example.com ,,+15551230001 , ',
  })
  expect(fence.sink).toBe(true)
  expect(fence.allowlist).toEqual(['alice@example.com', '+15551230001'])
})

test('staging with no allowlist refuses every recipient (fail-closed)', () => {
  for (const allowlist of [undefined, '', '   ', ' , ,']) {
    const fence = stagingFenceFromEnv({ APP_ENV: 'staging', STAGING_SINK_ALLOWLIST: allowlist })
    expect(() => assertSinkRecipient(fence, 'alice@example.com')).toThrow(FenceRefusal)
  }
})

test('staging allowlist matches emails case-insensitively, others exactly', () => {
  const fence = stagingFenceFromEnv({
    APP_ENV: 'staging',
    STAGING_SINK_ALLOWLIST: 'alice@example.com,+15551230001',
  })
  expect(() => assertSinkRecipient(fence, 'ALICE@EXAMPLE.COM')).not.toThrow()
  expect(() => assertSinkRecipient(fence, '+15551230001')).not.toThrow()
  expect(() => assertSinkRecipient(fence, 'bob@example.com')).toThrow(FenceRefusal)
  expect(() => assertSinkRecipient(fence, '+15551230002')).toThrow(FenceRefusal)
})

test('FIND-01: malformed non-empty entries are inert — kept, never matching, never throwing', () => {
  const fence = stagingFenceFromEnv({
    APP_ENV: 'staging',
    STAGING_SINK_ALLOWLIST: 'alice@example.com, not a recipient!!!, http://evil.example/x, Alice@Example.com',
  })
  expect(fence.sink).toBe(true)
  // The legitimate entry still works (duplicates collapse harmlessly).
  expect(() => assertSinkRecipient(fence, 'alice@example.com')).not.toThrow()
  // Junk entries widen nothing: matching is exact-equality only, so
  // substrings, prefixes, and unrelated recipients all refuse. (An
  // identical junk string identical-matches by design — harmless, since no
  // routable recipient looks like that and staging never delivers live.)
  for (const to of ['evil.example', 'alice', 'alice@example', 'bob@example.com', '']) {
    expect(() => assertSinkRecipient(fence, to)).toThrow(FenceRefusal)
  }
})

test('refusal carries a 403 status and names no recipient value beyond the policy', () => {
  const fence = stagingFenceFromEnv({ APP_ENV: 'staging', STAGING_SINK_ALLOWLIST: 'a@x.co' })
  try {
    assertSinkRecipient(fence, 'victim@example.com')
    expect.unreachable('must throw')
  } catch (err) {
    expect(err).toBeInstanceOf(FenceRefusal)
    expect((err as FenceRefusal).status).toBe(403)
    expect((err as Error).message).toMatch(/STAGING_SINK_ALLOWLIST/)
    expect((err as Error).message).not.toContain('victim@example.com')
  }
})
