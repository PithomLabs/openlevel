import { isRestrictedPreview, sideEffectPolicyFromEnv } from './policy'

test('R14-03: staging sinks with a parsed allowlist', () => {
  const policy = sideEffectPolicyFromEnv({ APP_ENV: 'staging', STAGING_SINK_ALLOWLIST: ' A@x.com , +1555 ' })
  expect(policy.mode).toBe('sink')
  expect(policy.allowlist).toEqual(['a@x.com', '+1555'])
})

test('R14-03: staging with no allowlist still sinks (recipients refuse at the sink)', () => {
  const policy = sideEffectPolicyFromEnv({ APP_ENV: 'staging' })
  expect(policy.mode).toBe('sink')
  expect(policy.allowlist).toEqual([])
})

test('R14-03: restricted production preview refuses everything', () => {
  const policy = sideEffectPolicyFromEnv({ APP_ENV: 'production', RESTRICTED_PREVIEW: 'true' })
  expect(policy.mode).toBe('refuse')
  expect(policy.reason).toMatch(/preview/)
})

test('R14-03: preview flag requires exact true; near-misses stay live production', () => {
  for (const value of ['True', '1', 'yes', '']) {
    const policy = sideEffectPolicyFromEnv({ APP_ENV: 'production', RESTRICTED_PREVIEW: value })
    expect(policy.mode).toBe('live')
  }
  expect(isRestrictedPreview({ APP_ENV: 'production', RESTRICTED_PREVIEW: 'true' })).toBe(true)
  expect(isRestrictedPreview({ APP_ENV: 'staging', RESTRICTED_PREVIEW: 'true' })).toBe(false)
})

test('R14-03: production and development are live', () => {
  expect(sideEffectPolicyFromEnv({ APP_ENV: 'production' }).mode).toBe('live')
  expect(sideEffectPolicyFromEnv({ APP_ENV: 'development' }).mode).toBe('live')
  expect(sideEffectPolicyFromEnv({}).mode).toBe('live')
})

test('R14-03: an unrecognized APP_ENV refuses (fail-closed backstop)', () => {
  const policy = sideEffectPolicyFromEnv({ APP_ENV: 'prod' })
  expect(policy.mode).toBe('refuse')
  expect(policy.reason).toMatch(/unrecognized APP_ENV/)
})

test('R14-11: policy refuses every environment identity the boot path rejects (§6 req 6)', () => {
  // Boot rejects these (closed vocabulary) — the policy backstop must
  // refuse, never deliver. Empty string is set-but-invalid, not unset.
  for (const bad of ['prod', 'STAGING', 'yes', '']) {
    expect(sideEffectPolicyFromEnv({ APP_ENV: bad }).mode).toBe('refuse')
  }
  // Boot accepts these — the policy delivers or sinks (preview is the
  // deliberate exception: boot accepts it, the policy refuses effects).
  expect(sideEffectPolicyFromEnv({ APP_ENV: 'staging', STAGING_SINK_ALLOWLIST: 'a@x.co' }).mode).toBe('sink')
  expect(sideEffectPolicyFromEnv({ APP_ENV: 'production' }).mode).toBe('live')
  expect(sideEffectPolicyFromEnv({ APP_ENV: 'development' }).mode).toBe('live')
  expect(sideEffectPolicyFromEnv({}).mode).toBe('live')
})
