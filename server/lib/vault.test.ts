import { FakeDatabase } from '../db/fake-database'
import { assertLocationNamespacesUnique, resolveSecret } from './vault'

test('resolveSecret reads an env var derived from the item name', () => {
  process.env.Alex_CHATWOOT_API_TOKEN = 'shh'
  expect(resolveSecret('Alex:chatwoot:api_token')).toBe('shh')
  delete process.env.Alex_CHATWOOT_API_TOKEN
})

test('resolveSecret returns undefined when the secret is absent', () => {
  expect(resolveSecret('nope:does:not:exist')).toBeUndefined()
})

test('resolveSecret matches all-caps deployed keys (FIND-11)', () => {
  process.env.PROBE_ALLCAPS_KEY = 'cap'
  try {
    expect(resolveSecret('probe:allcaps:key')).toBe('cap')
  } finally {
    delete process.env.PROBE_ALLCAPS_KEY
  }
})

test('resolveSecret matches exact-case keys without transforming them (FIND-11)', () => {
  process.env.Probe_Exact_Key = 'exact'
  try {
    expect(resolveSecret('Probe:Exact:Key')).toBe('exact')
  } finally {
    delete process.env.Probe_Exact_Key
  }
})

test('resolveSecret keeps distinct names distinguishable (FIND-11)', () => {
  process.env.PROBE_ALPHA = 'a'
  process.env.PROBE_BETA = 'b'
  try {
    expect(resolveSecret('probe:alpha')).toBe('a')
    expect(resolveSecret('probe:beta')).toBe('b')
  } finally {
    delete process.env.PROBE_ALPHA
    delete process.env.PROBE_BETA
  }
})

test('resolveSecret rejects case collisions instead of picking one (FIND-11)', () => {
  process.env.PROBE_CLASH = 'upper'
  process.env.probe_clash = 'lower'
  try {
    expect(() => resolveSecret('probe:clash')).toThrow(/ambiguous secret name/)
  } finally {
    delete process.env.PROBE_CLASH
    delete process.env.probe_clash
  }
})

test('resolveSecret resolves the dev-server provider keys (FIND-11)', () => {
  // Mirrors server/dev-server.ts: mixed-case client prefix, all-caps suffix.
  const key = `ProbeCli_ANTHROPIC_API_KEY`
  process.env[key] = 'dev-stub'
  try {
    expect(resolveSecret('probecli:anthropic:api_key')).toBe('dev-stub')
  } finally {
    delete process.env[key]
  }
})

test('resolveSecret passes empty values through (FIND-11)', () => {
  process.env.PROBE_EMPTY = ''
  try {
    expect(resolveSecret('probe:empty')).toBe('')
  } finally {
    delete process.env.PROBE_EMPTY
  }
})

test.each(['', ':::', '---'])('resolveSecret throws a clear error for invalid name %p (FIND-11)', (name) => {
  expect(() => resolveSecret(name)).toThrow(/invalid empty secret name/)
})

test('N7: separator variants of one name still resolve one key (documented lossy lookup)', () => {
  process.env.PROBE_N7_KEY = 'shared'
  try {
    expect(resolveSecret('probe:n7:key')).toBe('shared')
    expect(resolveSecret('probe-n7-key')).toBe('shared')
    expect(resolveSecret('probe n7 key')).toBe('shared')
  } finally {
    delete process.env.PROBE_N7_KEY
  }
})

test('N7: distinct tenant slugs sharing a namespace refuse at boot (acme-corp vs acme_corp)', async () => {
  const db = new FakeDatabase()
  db.enqueue([
    { id: 'loc1', slug: 'acme-corp', client_slug: null },
    { id: 'loc2', slug: 'acme_corp', client_slug: null },
  ])
  await expect(assertLocationNamespacesUnique(db)).rejects.toThrow(/share one secret namespace/)
})

test('N7: client_slug collides against another location slug (cross-field)', async () => {
  const db = new FakeDatabase()
  db.enqueue([
    { id: 'loc1', slug: 'acme', client_slug: 'Acme-Corp' },
    { id: 'loc2', slug: 'acme_corp', client_slug: null },
  ])
  await expect(assertLocationNamespacesUnique(db)).rejects.toThrow(/loc1.*loc2|share one secret namespace/)
})

test('N7: distinct namespaces and empty tables pass', async () => {
  const db = new FakeDatabase()
  db.enqueue([
    { id: 'loc1', slug: 'acme', client_slug: null },
    { id: 'loc2', slug: 'globex', client_slug: 'Globex Inc' },
  ])
  await expect(assertLocationNamespacesUnique(db)).resolves.toBeUndefined()
  const empty = new FakeDatabase()
  empty.enqueue([])
  await expect(assertLocationNamespacesUnique(empty)).resolves.toBeUndefined()
})

