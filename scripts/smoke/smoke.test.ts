import { PROBES, SOURCES, type SmokeTarget } from './inventory'
import { redact, scanCredentials } from './redact'

// --- inventory integrity: the single-inventory proof (refinement #5) --------

test('R14-05: probe ids are unique and every probe names its sources', () => {
  const ids = PROBES.map((p) => p.id)
  expect(new Set(ids).size).toBe(ids.length)
  for (const p of PROBES) {
    expect(p.targets.length).toBeGreaterThan(0)
    expect(p.sources.length).toBeGreaterThan(0)
  }
})

test('R14-05: every R14-05 Docker claim (D01..D12) maps to at least one probe', () => {
  const covered = new Set(PROBES.flatMap((p) => p.sources))
  for (const src of SOURCES.docker) expect(covered.has(src)).toBe(true)
})

test('R14-05: every staging smoke item (S01..S16 + records) maps to at least one probe', () => {
  const covered = new Set(PROBES.flatMap((p) => p.sources))
  for (const src of SOURCES.staging) expect(covered.has(src)).toBe(true)
})

test('R14-05: every preview smoke item (P01..P12 + records) maps to at least one probe', () => {
  const covered = new Set(PROBES.flatMap((p) => p.sources))
  for (const src of SOURCES.preview) expect(covered.has(src)).toBe(true)
})

test('R14-05: every probe cites a real source id (no dangling references)', () => {
  const known = new Set([...SOURCES.docker, ...SOURCES.staging, ...SOURCES.preview])
  for (const p of PROBES) {
    for (const src of p.sources) expect(known.has(src)).toBe(true)
  }
})

test('R14-05: safety probes run on all three targets (same probes, env-appropriate expectations)', () => {
  const all: SmokeTarget[] = ['local', 'staging', 'preview']
  for (const id of ['health', 'ready', 'auth', 'voice-sink', 'sms-sink', 'provider-non-invocation', 'credential-scan']) {
    expect(PROBES.find((p) => p.id === id)?.targets).toEqual(all)
  }
})

// --- redactor ----------------------------------------------------------------

test('R14-05: redactor strips secret shapes but preserves evidence (digests, ids)', () => {
  const digest = 'sha256:abc123def456'
  const dirty = [
    'cookie: ol_session=tok_abc123; Path=/',
    'Authorization: Bearer [REDACTED]',
    '{"email":"a@x.co","password":"hunter2"}',
    'postgres://app:s3cret@db:5432/openlevel',
    'key=sk_live_abc123 and whsec_def456',
    'sid AC1234567890abcdef1234567890ABCDEF here',
    'ghp_abcdefghij1234567890',
    '-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----',
    'hash $argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHQ$RdescfgvJqoscfd8fQ',
    `image ${digest}`,
    'release 2612a7a location loc_smoke_1',
  ].join('\n')
  const clean = redact(dirty)
  expect(clean).not.toMatch(/tok_abc123|secret-token|hunter2|s3cret|sk_live_abc123|whsec_def456|AC1234567890|ghp_abcdefghij|MIIB|argon2id/)
  expect(clean).toContain(digest)
  expect(clean).toContain('2612a7a')
  expect(clean).toContain('loc_smoke_1')
  expect(clean).toMatch(/\[REDACTED\]/)
})

test('R14-05: credential scan counts patterns without returning values', () => {
  const hits = scanCredentials('leak sk_live_AAA and sk_live_BBB plus ghp_CCC')
  expect(hits.find((h) => h.name === 'sk_live')?.count).toBe(2)
  expect(hits.find((h) => h.name === 'github-token')?.count).toBe(1)
  expect(hits.find((h) => h.name === 'private-key-block')?.count).toBe(0)
  const clean = scanCredentials('image sha256:abc release 2612a7a all healthy')
  expect(clean.every((h) => h.count === 0)).toBe(true)
})
