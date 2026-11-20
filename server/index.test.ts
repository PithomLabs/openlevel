import { vi } from 'vitest'
import { FakeDatabase } from './db/fake-database'
import { createApp } from './index'
import type { SendTextFn } from './lib/operator-tools'
import { createSession } from './lib/session'

function app(db = new FakeDatabase()) {
  return createApp({ db, sessionSecret: 'sek', webhookSecret: 'whsek' })
}

test('health is public', async () => {
  const res = await app().request('/health')
  expect(res.status).toBe(200)
  expect(await res.json()).toMatchObject({ ok: true, service: 'openlevel' })
})

test('ready without a wired probe reports starting, not healthy', async () => {
  const res = await app().request('/ready')
  expect(res.status).toBe(503)
  expect(await res.json()).toEqual({ ready: false, reason: 'starting' })
})

test('R14-11: /api/client-config advertises preview mode publicly (no session)', async () => {
  const plain = await app().request('/api/client-config')
  expect(plain.status).toBe(200)
  expect(await plain.json()).toEqual({ preview: false })
  const previewed = createApp({ db: new FakeDatabase(), sessionSecret: 'sek', webhookSecret: 'whsek', preview: true })
  const res = await previewed.request('/api/client-config')
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ preview: true })
})

test('ready with a ready probe reports 200', async () => {
  const ready = createApp({
    db: new FakeDatabase(),
    sessionSecret: 'sek',
    webhookSecret: 'whsek',
    readiness: async () => ({ ready: true }),
  })
  const res = await ready.request('/ready')
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ ready: true })
})

test('thrown route error returns generic 500 and logs scrubbed (FIND-01 e2e)', async () => {
  const CANARY = 'postgres://op:CANARY_ROUTE_PW@db.internal:5432/app'
  const db = new FakeDatabase()
  db.enqueueError(Object.assign(new Error(`connect ${CANARY} refused`), { code: 'ECONNREFUSED' }))
  const lines: string[] = []
  const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '))
  })
  try {
    const token = createSession({ operatorId: 'op1' }, 'sek')
    const res = await app(db).request('/api/locations', { headers: { Cookie: `ol_session=${token}` } })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'internal error' })
  } finally {
    spy.mockRestore()
  }
  const out = lines.join('\n')
  expect(out).toContain('[http GET /api/locations]')
  expect(out).not.toContain('CANARY_ROUTE_PW')
  expect(out).toContain('postgres://op:****@')
})

test('nested provider error through a route leaks nothing (FIND-01 e2e)', async () => {
  // The canary rides in a real secret slot so the ambient default secret set
  // (the production path) scrubs it; nothing is passed explicitly.
  process.env.INTERNAL_PUSH_SECRET = 'PROVIDER_CANARY_TOKEN_zz9'
  const db = new FakeDatabase()
  db.enqueueError(new Error('dispatch failed', { cause: new Error('provider said no PROVIDER_CANARY_TOKEN_zz9') }))
  const lines: string[] = []
  const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '))
  })
  try {
    const token = createSession({ operatorId: 'op1' }, 'sek')
    const res = await app(db).request('/api/locations', { headers: { Cookie: `ol_session=${token}` } })
    expect(res.status).toBe(500)
  } finally {
    spy.mockRestore()
    delete process.env.INTERNAL_PUSH_SECRET
  }
  const out = lines.join('\n')
  expect(out).not.toContain('PROVIDER_CANARY_TOKEN')
  expect(out).toContain('[REDACTED]')
  expect(out).toContain('caused by')
})

test('ready with a failing probe reports 503 with a short reason and no leak', async () => {
  const ready = createApp({
    db: new FakeDatabase(),
    sessionSecret: 'sek',
    webhookSecret: 'whsek',
    readiness: async () => ({ ready: false, reason: 'db-timeout' }),
  })
  const res = await ready.request('/ready')
  expect(res.status).toBe(503)
  const body = await res.json()
  expect(body).toEqual({ ready: false, reason: 'db-timeout' })
  expect(JSON.stringify(body)).not.toMatch(/postgres|secret|token|stack|Error/i)
})

test('GET /api/locations requires a session', async () => {
  const res = await app().request('/api/locations')
  expect(res.status).toBe(401)
})

test('location-scoped routes require a session', async () => {
  const res = await app().request('/api/loc/locA/contacts')
  expect(res.status).toBe(401)
})

test('authenticated operator without access to the location gets 403', async () => {
  const db = new FakeDatabase()
  db.enqueue([]) // hasAccess -> none
  const token = createSession({ operatorId: 'op1' }, 'sek')
  const res = await app(db).request('/api/loc/locA/contacts', {
    headers: { Cookie: `ol_session=${token}` },
  })
  expect(res.status).toBe(403)
})

test('chatwoot webhook with the wrong secret is 401', async () => {
  const res = await app().request('/api/webhooks/chatwoot?secret=wrong', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event: 'message_created' }),
  })
  expect(res.status).toBe(401)
})

// --- the text rail is wired end-to-end through createApp (slice 3B) -------------
// Prod injects the gateway rail at the top of the tree; this proves it actually
// reaches the assistant /confirm send_text handler through the real auth + tenant
// middleware — not just the route unit in isolation.

test('createApp threads the gateway text rail into the assistant /confirm send_text path', async () => {
  const db = new FakeDatabase()
  const CONTACT = { id: 'c1', location_id: 'locA', name: 'Jane Doe', phones: ['+16025551234'], emails: [], tags: [] }
  db.enqueue([{ id: 'locA' }]) // locationAccess: hasAccess -> granted
  db.enqueue([{ role: 'owner' }]) // locationAccess: getRole -> owner
  db.enqueue([CONTACT]) // resolve(confirm) -> prepareText -> contacts.get
  db.enqueue([CONTACT]) // perform -> prepareText -> contacts.get
  const calls: Array<{ e164: string; body: string; nonce: string }> = []
  const sendText: SendTextFn = async (e164, body, nonce) => {
    calls.push({ e164, body, nonce })
    return { ok: true, messageId: 'gw1' }
  }
  const token = createSession({ operatorId: 'op1' }, 'sek')
  const res = await createApp({ db, sessionSecret: 'sek', webhookSecret: 'whsek', sendText }).request(
    '/api/loc/locA/assistant/confirm',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `ol_session=${token}` },
      body: JSON.stringify({ verb: 'send_text', params: { contactId: 'c1', body: 'Hi Jane', nonce: 'n1' } }),
    },
  )
  expect(res.status).toBe(200)
  expect(await res.json()).toMatchObject({ message: expect.stringMatching(/sent your text/i) })
  // the real rail was reached, with the contact's derived number + the echoed nonce
  expect(calls).toEqual([{ e164: '+16025551234', body: 'Hi Jane', nonce: 'n1' }])
})

// --- the hub federation surface is mounted, but inert until a token is set --------
// createApp wires /federation/* with its OWN bearer gate (separate from operator
// sessions). With no FEDERATION_SERVICE_TOKEN the whole surface answers 503 ("not
// turned on"); once a token is configured it answers, and a wrong bearer is 401.

test('federation surface is inert (503) when no token is configured', async () => {
  const res = await app().request('/federation/capabilities', { headers: { authorization: 'Bearer anything' } })
  expect(res.status).toBe(503)
})

test('federation capabilities answer (200) once a token is configured, 401 on a wrong bearer', async () => {
  const built = createApp({
    db: new FakeDatabase(),
    sessionSecret: 'sek',
    webhookSecret: 'whsek',
    federationServiceToken: 'fed-token',
  })
  const ok = await built.request('/federation/capabilities', { headers: { authorization: 'Bearer fed-token' } })
  expect(ok.status).toBe(200)
  expect(await ok.json()).toMatchObject({ app: 'openlevel' })
  const bad = await built.request('/federation/capabilities', { headers: { authorization: 'Bearer wrong' } })
  expect(bad.status).toBe(401)
})

test('R13-12: contact-identity conflicts surface as structured 409s, never 500s, and are not error-logged', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ '?column?': 1 }]) // locationAccess membership
  db.enqueue([{ role: 'owner' }]) // locationAccess role
  db.enqueue([{ id: 'c-arch', phones: ['+15035550142'], emails: [], archived_at: '2026-01-01T00:00:00Z' }]) // findByPhone -> archived
  const lines: string[] = []
  const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '))
  })
  try {
    const token = createSession({ operatorId: 'op1' }, 'sek')
    const res = await app(db).request('/api/loc/locA/contacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `ol_session=${token}` },
      body: JSON.stringify({ name: 'Zed', phone: '+15035550142' }),
    })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'archived_match', contactIds: ['c-arch'] })
  } finally {
    spy.mockRestore()
  }
  expect(lines.join('\n')).toBe('')
})
