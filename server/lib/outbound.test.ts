import { FakeDatabase } from '../db/fake-database'
import { sendOutboundMessage } from './outbound'

const CONV = { id: 'conv1', contact_id: 'c1', external_id: '55' }
const LINK = {
  location_id: 'locA',
  inbox_id: '7',
  config: { baseUrl: 'https://chat', accountId: '1', tokenSecretName: 'Alex:chatwoot:api_token' },
}

function scriptedDb() {
  const db = new FakeDatabase()
  db.enqueue([CONV]) // conversations.get
  db.enqueue([LINK]) // getForLocation
  db.enqueue([]) // sink INSERT (no rows needed)
  db.enqueue([{ id: 'm-out', direction: 'outbound' }]) // insertOutbound
  db.enqueue([{ id: 't-out' }]) // timeline add
  db.enqueue([]) // touch (UPDATE)
  return db
}

test('staging sinks chatwoot outbound: provider never called, message marked simulated', async () => {
  const db = scriptedDb()
  const sendMessage = vi.fn()
  const res = await sendOutboundMessage(
    db,
    'locA',
    { conversationId: 'conv1', body: 'hello back', authorType: 'operator', authorId: null },
    {
      sendMessage,
      resolveSecret: () => 'tok',
      env: { APP_ENV: 'staging', STAGING_SINK_ALLOWLIST: 'a@x.co' },
    },
  )
  expect(res.ok).toBe(true)
  expect(res.simulated).toBe(true)
  expect(sendMessage).not.toHaveBeenCalled()
  const sinkCall = db.calls.find((c) => /INSERT INTO outbound_sink/i.test(c.sql))
  expect(sinkCall?.params).toContain('chatwoot')
  expect(sinkCall?.params).toContain('chatwoot:55')
  // The persisted message is honestly attributed to the sink, not chatwoot,
  // and its status says simulated, never sent (R13-07).
  const insert = db.calls.find((c) => /INSERT INTO messages/i.test(c.sql))
  expect(insert?.params).toContain('sink')
  expect(insert?.params).toContain('simulated')
  expect(insert?.params).not.toContain('sent')
})

test('R14-03: restricted production preview refuses chatwoot outbound: provider never called, nothing recorded', async () => {
  const db = scriptedDb()
  const sendMessage = vi.fn()
  const res = await sendOutboundMessage(
    db,
    'locA',
    { conversationId: 'conv1', body: 'hello back', authorType: 'operator', authorId: null },
    {
      sendMessage,
      resolveSecret: () => 'tok',
      env: { APP_ENV: 'production', RESTRICTED_PREVIEW: 'true' },
    },
  )
  expect(res.ok).toBe(false)
  expect(res.status).toBe(400)
  expect(sendMessage).not.toHaveBeenCalled()
  expect(db.calls.find((c) => /INSERT INTO outbound_sink/i.test(c.sql))).toBeUndefined()
  expect(db.calls.find((c) => /INSERT INTO messages/i.test(c.sql))).toBeUndefined()
})

test('non-staging chatwoot outbound still calls the provider with no sink row', async () => {
  const db = new FakeDatabase()
  db.enqueue([CONV])
  db.enqueue([LINK])
  db.enqueue([{ id: 'm-out', direction: 'outbound' }]) // insertOutbound
  db.enqueue([{ id: 't-out' }]) // timeline add
  db.enqueue([]) // touch
  const sendMessage = vi.fn(async () => ({ externalId: 'cw-99' }))
  const res = await sendOutboundMessage(
    db,
    'locA',
    { conversationId: 'conv1', body: 'hello back', authorType: 'operator', authorId: null },
    { sendMessage, resolveSecret: () => 'tok', env: { APP_ENV: 'development' } },
  )
  expect(res.ok).toBe(true)
  expect(res.simulated).toBeUndefined()
  expect(sendMessage).toHaveBeenCalledTimes(1)
  expect(db.calls.some((c) => /outbound_sink/i.test(c.sql))).toBe(false)
})
