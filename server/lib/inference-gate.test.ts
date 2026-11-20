import { INFERENCE_REFUSAL, isInferenceAllowed } from './inference-gate'

test('R14-12: inference requires exact-true owner attestation — nothing else counts', () => {
  expect(isInferenceAllowed({ syntheticAttested: true })).toBe(true)
  expect(isInferenceAllowed({})).toBe(false)
  expect(isInferenceAllowed(null)).toBe(false)
  expect(isInferenceAllowed(undefined)).toBe(false)
  // Near-misses never attest: truthy strings, 1, and nested objects are NOT approval.
  expect(isInferenceAllowed({ syntheticAttested: 'true' })).toBe(false)
  expect(isInferenceAllowed({ syntheticAttested: 1 })).toBe(false)
  expect(isInferenceAllowed({ syntheticAttested: {} })).toBe(false)
  expect(INFERENCE_REFUSAL).toMatch(/not enabled for this tenant/)
})
