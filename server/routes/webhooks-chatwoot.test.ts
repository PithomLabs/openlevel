import { createHmac } from 'node:crypto'
import type { Hono } from 'hono'
import { FakeDatabase } from '../db/fake-database'
import { chatwootWebhookRoute } from './webhooks-chatwoot'

const payload = {
  event: 'message_created',
  message_type: 'incoming',
  content: 'hi',
  id: 991,
  conversation: { id: 55 },
  inbox: { id: 7 },
  sender: { name: 'Bob', phone_number: '+15035550199', email: null },
}

function post(app: Hono, body: unknown, secret = 'sek') {
  return app.request('/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-webhook-secret': secret },
    body: JSON.stringify(body),
  })
}

function postHeader(app: Hono, body: unknown, secret: string) {
  return app.request('/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-webhook-secret': secret },
    body: JSON.stringify(body),
  })
}

function sign(secret: string, timestamp: string, rawBody: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')}`
}

function postSigned(
  app: Hono,
  body: unknown,
  opts: { secret?: string; timestamp?: string; tamper?: boolean; omitTimestamp?: boolean } = {},
) {
  const rawBody = JSON.stringify(body)
  const timestamp = opts.timestamp ?? '1763600000'
  const sentBody = opts.tamper ? `${rawBody} ` : rawBody
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-chatwoot-signature': sign(opts.secret ?? 'sek', timestamp, rawBody),
  }
  if (!opts.omitTimestamp) headers['x-chatwoot-timestamp'] = timestamp
  return app.request('/', { method: 'POST', headers, body: sentBody })
}

// now pinned inside the 5-minute freshness window for timestamp 1763600000
const signedApp = (db = new FakeDatabase()) =>
  chatwootWebhookRoute({ db, webhookSecret: 'sek', now: () => 1763600000 * 1000 })

test('rejects a wrong webhook secret with 401', async () => {
  const app = chatwootWebhookRoute({ db: new FakeDatabase(), webhookSecret: 'sek' })
  const res = await post(app, payload, 'wrong') // different length than the real secret
  expect(res.status).toBe(401) // and the timing-safe compare does not throw on the length mismatch
})

test('ignores ?secret= even when correct: query secrets were removed (G6)', async () => {
  const app = chatwootWebhookRoute({ db: new FakeDatabase(), webhookSecret: 'sek' })
  const res = await app.request('/?secret=sek', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  expect(res.status).toBe(401)
})

test('rejects a request that carries no secret at all with 401', async () => {
  const app = chatwootWebhookRoute({ db: new FakeDatabase(), webhookSecret: 'sek' })
  const res = await app.request('/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  expect(res.status).toBe(401)
})

test('accepts the secret from the x-webhook-secret header (the non-leaking path)', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ location_id: 'locAlex', inbox_id: '7', config: {} }]) // resolveLocation
  db.enqueue([]) // findByPhone -> no match
  db.enqueue([{ id: 'c1', location_id: 'locAlex', phones: [], emails: [], created: true }]) // contacts upsert (atomic)
  db.enqueue([{ id: 'conv1', location_id: 'locAlex' }]) // conversations upsert (atomic)
  db.enqueue([{ id: 'm1', location_id: 'locAlex' }]) // messages insertInbound
  db.enqueue([{ id: 't1' }]) // timeline add
  db.enqueue([]) // conversations touch

  const app = chatwootWebhookRoute({ db, webhookSecret: 'sek' })
  const res = await postHeader(app, payload, 'sek')
  expect(res.status).toBe(200)
  expect(await res.json()).toMatchObject({ ok: true, contactId: 'c1' })
})

test('rejects a wrong header secret with 401', async () => {
  const app = chatwootWebhookRoute({ db: new FakeDatabase(), webhookSecret: 'sek' })
  const res = await postHeader(app, payload, 'nope')
  expect(res.status).toBe(401)
})

test('ignores non-message events with 200', async () => {
  const app = chatwootWebhookRoute({ db: new FakeDatabase(), webhookSecret: 'sek' })
  const res = await post(app, { event: 'conversation_status_changed' })
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ ignored: true })
})

test('ingests inbound: contact + conversation + message + timeline, all location-scoped', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ location_id: 'locAlex', inbox_id: '7', config: {} }]) // resolveLocation
  db.enqueue([]) // findByPhone -> no match
  db.enqueue([{ id: 'c1', location_id: 'locAlex', phones: [], emails: [], created: true }]) // contacts upsert (atomic)
  db.enqueue([{ id: 'conv1', location_id: 'locAlex' }]) // conversations upsert (atomic)
  db.enqueue([{ id: 'm1', location_id: 'locAlex' }]) // messages insertInbound
  db.enqueue([{ id: 't1' }]) // timeline add
  db.enqueue([]) // conversations touch (UPDATE)

  const app = chatwootWebhookRoute({ db, webhookSecret: 'sek' })
  const res = await post(app, payload)
  expect(res.status).toBe(200)
  expect(await res.json()).toMatchObject({ ok: true, contactId: 'c1', conversationId: 'conv1', messageId: 'm1' })

  // every query after resolveLocation carried the resolved location id
  for (const call of db.calls.slice(1)) {
    expect(call.params).toContain('locAlex')
  }
})

function ingestWithDispatch(created: boolean) {
  const db = new FakeDatabase()
  db.enqueue([{ location_id: 'locAlex', inbox_id: '7', config: {} }]) // resolveLocation
  if (created) {
    db.enqueue([]) // findByPhone -> no match
    db.enqueue([{ id: 'c1', location_id: 'locAlex', created }]) // contacts insert
  } else {
    db.enqueue([{ id: 'c1', location_id: 'locAlex', phones: ['+15035550199'], emails: [], archived_at: null }]) // findByPhone -> live match
  }
  db.enqueue([{ id: 'conv1', location_id: 'locAlex' }]) // conversations upsert (atomic)
  db.enqueue([{ id: 'm1', location_id: 'locAlex' }]) // messages insertInbound
  db.enqueue([{ id: 't1' }]) // timeline add
  db.enqueue([]) // conversations touch (UPDATE)
  const events: unknown[] = []
  const app = chatwootWebhookRoute({
    db,
    webhookSecret: 'sek',
    dispatch: (e) => {
      events.push(e)
    },
  })
  return { db, app, events }
}

test('inbound from a new contact fires contact_created (FIND-07)', async () => {
  const { app, events } = ingestWithDispatch(true)
  const res = await post(app, payload)
  expect(res.status).toBe(200)
  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({ locationId: 'locAlex', triggerType: 'contact_created', contactId: 'c1' })
})

test('inbound from a known contact fires no contact_created (FIND-07)', async () => {
  const { app, events } = ingestWithDispatch(false)
  const res = await post(app, payload)
  expect(res.status).toBe(200)
  expect(events).toEqual([])
})

test('enqueues onInbound after a fresh inbound message', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ location_id: 'locAlex', inbox_id: '7', config: {} }]) // resolveLocation
  db.enqueue([]) // findByPhone -> no match
  db.enqueue([{ id: 'c1', phones: [], emails: [], created: true }]) // contacts upsert
  db.enqueue([{ id: 'conv1' }]) // conversations upsert
  db.enqueue([{ id: 'm1' }]) // messages insertInbound
  db.enqueue([{ id: 't1' }]) // timeline add
  db.enqueue([]) // conversations touch

  const seen: unknown[] = []
  const app = chatwootWebhookRoute({
    db,
    webhookSecret: 'sek',
    onInbound: (e) => {
      seen.push(e)
    },
  })
  await post(app, payload)
  expect(seen).toEqual([
    { locationId: 'locAlex', conversationId: 'conv1', contactId: 'c1', messageId: 'm1', contactName: 'Bob', preview: 'hi' },
  ])
})

test('accepts a valid Chatwoot HMAC signature (G6)', async () => {
  const app = signedApp()
  const res = await postSigned(app, { event: 'conversation_status_changed' })
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ ignored: true })
})

test('rejects a signature made with the wrong secret (G6)', async () => {
  const app = signedApp()
  const res = await postSigned(app, payload, { secret: 'wrong' })
  expect(res.status).toBe(401)
})

test('rejects a tampered body even with a valid signature over the original (G6)', async () => {
  const app = signedApp()
  const res = await postSigned(app, payload, { tamper: true })
  expect(res.status).toBe(401)
})

test('rejects a stale signed timestamp as a replay (G6)', async () => {
  const app = signedApp()
  const res = await postSigned(app, payload, { timestamp: '1763500000' }) // ~28h old
  expect(res.status).toBe(401)
})

test('rejects a signature without its timestamp (G6)', async () => {
  const app = signedApp()
  const res = await postSigned(app, payload, { omitTimestamp: true })
  expect(res.status).toBe(401)
})

test('dedupes a repeated message (insertInbound conflict) without timeline write', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ location_id: 'locAlex', inbox_id: '7', config: {} }]) // resolveLocation
  db.enqueue([]) // findByPhone -> no match
  db.enqueue([{ id: 'c1', phones: [], emails: [], created: true }]) // contacts upsert
  db.enqueue([{ id: 'conv1' }]) // conversations upsert
  db.enqueue([]) // insertInbound -> conflict -> null

  const app = chatwootWebhookRoute({ db, webhookSecret: 'sek' })
  const res = await post(app, payload)
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ ok: true, deduped: true })
  expect(db.calls).toHaveLength(5) // no timeline, no touch
})

