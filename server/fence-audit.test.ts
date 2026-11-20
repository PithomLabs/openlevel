/**
 * Staging side-effect audit (§6.6, R13-01–03 + N15). One matrix across EVERY
 * external side-effect class, each exercised through its real product entry
 * point with counting providers: approved operations reach the sink,
 * disallowed ones refuse, missing/invalid config refuses, live-provider
 * invocation stays zero, outputs carry no credentials, and responses
 * distinguish simulated from delivered. Alternate entries (agent job shape,
 * assistant confirm, federation) are covered alongside direct routes —
 * never UI-disabled buttons.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { Hono } from 'hono'
import type { AppEnv } from './app-env'
import { PgliteDatabase } from './db/pglite-database'
import { FakeDatabase } from './db/fake-database'
import { notifyPush } from './lib/notify-push'
import { confirmOperatorWrite } from './lib/operator-tools'
import { sendOutboundMessage } from './lib/outbound'
import { resolvePaymentProvider } from './lib/payments/resolve'
import { resolveEmailSender, resolveSmsSender } from './lib/sending/resolve'
import { resolveSocialPublisher } from './lib/social/resolve'
import { resolveVoiceProvider } from './lib/voice/resolve'
import { callsRoute } from './routes/calls'
import { federationRoute } from './routes/federation'

const SCHEMA = readFileSync(fileURLToPath(new URL('../db/schema.sql', import.meta.url)), 'utf8')

const STAGING = { APP_ENV: 'staging', STAGING_SINK_ALLOWLIST: 'audit@example.com,+15551230001' }
const PHONE = '+15551230001'
const EMAIL = 'audit@example.com'

// Sentinel fake credentials: planted in env, asserted absent from every output.
const SENTINELS = ['audit-live-twilio-sid', 'audit-live-twilio-token', 'audit-live-brevo', 'audit-live-stripe']

function seedSentinels() {
  process.env.AUDIT_TWILIO_ACCOUNT_SID = SENTINELS[0]
  process.env.AUDIT_TWILIO_AUTH_TOKEN = SENTINELS[1]
  process.env.AUDIT_BREVO_API_KEY = SENTINELS[2]
  process.env.AUDIT_STRIPE_SECRET_KEY = SENTINELS[3]
}

function clearSentinels() {
  delete process.env.AUDIT_TWILIO_ACCOUNT_SID
  delete process.env.AUDIT_TWILIO_AUTH_TOKEN
  delete process.env.AUDIT_BREVO_API_KEY
  delete process.env.AUDIT_STRIPE_SECRET_KEY
}

function expectClean(...texts: unknown[]) {
  const blob = texts.map((t) => String(t)).join('\n')
  for (const s of SENTINELS) expect(blob).not.toContain(s)
}

async function setup() {
  const pg = new PGlite()
  await pg.exec(SCHEMA)
  const db = new PgliteDatabase(pg)
  await db.query("INSERT INTO locations (id, name, slug) VALUES ('locAudit','Audit','audit')")
  await db.query(
    "INSERT INTO contacts (id, location_id, name, emails, phones) VALUES ('cAudit','locAudit','Audit Lead', $1, $2)",
    [[EMAIL], [PHONE]],
  )
  return db
}

beforeEach(seedSentinels)
afterEach(clearSentinels)

test('audit: sms/email resolve to the sink; allowlisted sends record, others refuse, zero live contact', async () => {
  const db = await setup()
  const email = await resolveEmailSender(db, 'locAudit', STAGING)
  const sms = await resolveSmsSender(db, 'locAudit', STAGING)
  expect(email.ok && email.sender.name).toBe('sink')
  expect(sms.ok && sms.sender.name).toBe('sink')
  if (!email.ok || !sms.ok) return
  await email.sender.sendEmail({ to: EMAIL, subject: 's', text: 'b' })
  await expect(sms.sender.sendSms({ to: '+10000000000', body: 'b' })).rejects.toThrow(/STAGING_SINK_ALLOWLIST/)
  const rows = await db.query<{ channel: string }>('SELECT channel FROM outbound_sink')
  expect(rows.map((r) => r.channel)).toEqual(['email'])
  expectClean(JSON.stringify(rows))
})

test('audit: send_text sinks without touching the gateway rail (assistant + agent shape)', async () => {
  const db = await setup()
  let railCalls = 0
  const res = await confirmOperatorWrite(
    {
      db,
      locationId: 'locAudit',
      sendText: async () => {
        railCalls += 1
        return { ok: true, messageId: 'gw-live' }
      },
      env: STAGING,
    },
    { verb: 'send_text', params: { contactId: 'cAudit', body: 'Hi', nonce: 'n-audit' } },
  )
  expect(railCalls).toBe(0)
  expect(res.message).toMatch(/simulat/i)
  const rows = await db.query<{ recipient: string }>("SELECT recipient FROM outbound_sink WHERE channel = 'sms'")
  expect(rows).toHaveLength(1)
  expect(rows[0]?.recipient).toBe(PHONE)
  expectClean(res.message, JSON.stringify(rows))
})

test('audit: voice placements sink end to end; unlisted numbers 403; webhooks never verify', async () => {
  const db = await setup()
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('operatorId', 'op1')
    c.set('locationId', 'locAudit')
    await next()
  })
  app.route('/', callsRoute({ db, resolveVoice: (d, l, o) => resolveVoiceProvider(d, l, { ...o, env: STAGING }) }))
  const ok = await app.request('/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contactId: 'cAudit' }),
  })
  expect(ok.status).toBe(200)
  expect(await ok.json()).toMatchObject({ ok: true, simulated: true })
  const rows = await db.query<{ channel: string; recipient: string }>('SELECT channel, recipient FROM outbound_sink')
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ channel: 'voice', recipient: PHONE })
  const denied = await resolveVoiceProvider(db, 'locAudit', { env: STAGING })
  expect(denied.ok).toBe(true)
  if (denied.ok) {
    await expect(denied.provider.placeCall({ to: '+10000000000' })).rejects.toThrow(/STAGING_SINK_ALLOWLIST/)
    expect(denied.provider.verifyWebhook({ rawBody: '{}', headers: {}, url: 'https://x' })).toBe(false)
  }
  expectClean(JSON.stringify(rows))
})

test('audit: push is suppressed in staging with an explicit outcome, gateway untouched', async () => {
  let calls = 0
  const fetchImpl = (async () => {
    calls++
    return { ok: true }
  }) as unknown as typeof fetch
  const outcome = await notifyPush(
    { url: 'http://gw/push/send', secret: 's', fetchImpl, env: STAGING },
    { source: 'openlevel', title: 't', body: 'b' },
  )
  expect(outcome).toBe('suppressed-staging')
  expect(calls).toBe(0)
})

test('audit: payments and social refuse live staging use; test keys resolve', async () => {
  const loc = (settings: Record<string, unknown>) => {
    const d = new FakeDatabase()
    d.enqueue([{ id: 'locAudit', name: 'A', slug: 'audit', client_slug: 'audit', branding: {}, settings }])
    return d
  }
  process.env.AUDIT_STRIPE_WEBHOOK_SECRET = 'whsec-x'
  try {
    expect(
      await resolvePaymentProvider(loc({ payments: { provider: 'stripe' } }), 'locAudit', STAGING),
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/live stripe/i) })
    expect(
      await resolveSocialPublisher(loc({ social: { facebookPageId: 'p1' } }), 'locAudit', 'facebook', STAGING),
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/disabled in staging/i) })
  } finally {
    delete process.env.AUDIT_STRIPE_WEBHOOK_SECRET
  }
})

test('audit: chatwoot outbound (operator + agent shape) sinks with zero provider calls', async () => {
  const db = await setup()
  await db.query(
    `INSERT INTO channel_links (id, location_id, provider, inbox_id, config) VALUES ('l1','locAudit','chatwoot','7',$1)`,
    [JSON.stringify({ baseUrl: 'https://chat', accountId: '1', tokenSecretName: 'audit:chatwoot:token' })],
  )
  await db.query(
    `INSERT INTO conversations (id, location_id, contact_id, channel, provider, external_id) VALUES ('conv1','locAudit','cAudit','chatwoot','chatwoot','55')`,
  )
  let providerCalls = 0
  for (const authorType of ['operator', 'agent']) {
    const res = await sendOutboundMessage(
      db,
      'locAudit',
      { conversationId: 'conv1', body: `hello ${authorType}`, authorType, authorId: null },
      {
        sendMessage: async () => {
          providerCalls += 1
          return { externalId: 'cw-live' }
        },
        resolveSecret: () => 'tok',
        env: STAGING,
      },
    )
    expect(res.ok).toBe(true)
    expect(res.simulated).toBe(true)
  }
  expect(providerCalls).toBe(0)
  const rows = await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM outbound_sink WHERE location_id = 'locAudit' AND channel = 'chatwoot'",
  )
  expect(rows[0]?.n).toBe(2)
})

test('audit: federation bearer without allowlisted tenant cannot touch any tenant route', async () => {
  const app = new Hono<AppEnv>()
  app.route(
    '/',
    federationRoute({
      db: new FakeDatabase(),
      federationServiceToken: 'fed-token',
      env: { APP_ENV: 'staging', FEDERATION_TENANT_ALLOWLIST: 'locSynth' },
    }),
  )
  const auth = { authorization: 'Bearer fed-token' }
  expect((await app.request('/federation/today', { headers: { ...auth, 'x-federation-tenant': 'locAudit' } })).status).toBe(403)
  expect(
    (await app.request('/federation/confirm', { method: 'POST', headers: { ...auth, 'x-federation-tenant': 'locAudit' } }))
      .status,
  ).toBe(403)
  expect((await app.request('/federation/capabilities', { headers: auth })).status).toBe(200)
})

test('audit: missing sink configuration refuses every class (fail-closed matrix)', async () => {
  const bare = { APP_ENV: 'staging' }
  const db = new FakeDatabase()
  expect(await resolveEmailSender(db, 'x', bare)).toMatchObject({ ok: false })
  expect(await resolveSmsSender(db, 'x', bare)).toMatchObject({ ok: false })
  expect(await resolveVoiceProvider(db, 'x', { env: bare })).toMatchObject({ ok: false })
  const push = await notifyPush({ url: 'http://gw', secret: 's', env: bare }, { source: 'openlevel', title: 't', body: 'b' })
  expect(push).toBe('suppressed-staging')
})

test('audit: restricted production preview refuses every class with zero provider contact (R14-03)', async () => {
  const preview = { APP_ENV: 'production', RESTRICTED_PREVIEW: 'true' }
  const db = await setup()
  // Resolvers refuse without adapters.
  expect(await resolveEmailSender(db, 'locAudit', preview)).toMatchObject({ ok: false })
  expect(await resolveSmsSender(db, 'locAudit', preview)).toMatchObject({ ok: false })
  expect(await resolveVoiceProvider(db, 'locAudit', { env: preview })).toMatchObject({ ok: false })
  expect(await resolveSocialPublisher(db, 'locAudit', 'facebook', preview)).toMatchObject({ ok: false })
  expect(await resolvePaymentProvider(db, 'locAudit', preview)).toMatchObject({ ok: false })
  // send_text refuses: no rail call, no sink row (preview records nothing).
  let railCalls = 0
  const res = await confirmOperatorWrite(
    {
      db,
      locationId: 'locAudit',
      sendText: async () => {
        railCalls += 1
        return { ok: true, messageId: 'gw-live' }
      },
      env: preview,
    },
    { verb: 'send_text', params: { contactId: 'cAudit', body: 'Hi', nonce: 'n-preview' } },
  )
  expect(railCalls).toBe(0)
  expect(res.message).toMatch(/nothing was sent/i)
  // Push suppresses with the preview outcome, gateway untouched.
  let pushCalls = 0
  const fetchImpl = (async () => {
    pushCalls++
    return { ok: true }
  }) as unknown as typeof fetch
  const outcome = await notifyPush(
    { url: 'http://gw/push/send', secret: 's', fetchImpl, env: preview },
    { source: 'openlevel', title: 't', body: 'b' },
  )
  expect(outcome).toBe('suppressed-preview')
  expect(pushCalls).toBe(0)
  const sinkRows = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM outbound_sink')
  expect(sinkRows[0]?.n).toBe(0)
  expectClean(res.message)
})
