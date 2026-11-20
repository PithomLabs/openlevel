/**
 * Campaign cancel/dispatch interleaving on real PostgreSQL (R14-09): a
 * mid-blast cancel must stop new recipient attempts (the in-flight provider
 * call's outcome is honored, later recipients stay pending, the blast
 * reports cancelled without markSent), and racing sends must collapse at
 * the atomic claim. The real sendCampaign loop runs with a blocking fake
 * SMS sender — only the provider call is fake. Runs via `task test:pg`.
 */
import { readFileSync } from 'node:fs'
import { Hono } from 'hono'
import { Pool } from 'pg'
import { inject } from 'vitest'
import type { AppEnv } from '../app-env'
import { PgDatabase } from '../db/database'
import type { SmsSender } from '../lib/sending/provider'
import { sendCampaign, type CampaignSendDeps, type CampaignSendInput } from '../lib/sending/campaign-send'
import { CampaignsRepo } from '../repos/campaigns-repo'
import { campaignsRoute } from './campaigns'

const baseUrl: string = inject('pgTestUrl') ?? process.env.OPENLEVEL_PG_TEST_URL ?? ''
if (baseUrl === '') throw new Error('pgTestUrl not provided — run via task test:pg')

const SCHEMA = readFileSync(new URL('../../db/schema.sql', import.meta.url), 'utf8')

beforeAll(async () => {
  const pool = new Pool({ connectionString: baseUrl })
  try {
    await pool.query(SCHEMA)
  } finally {
    await pool.end()
  }
})

async function setup() {
  const pool = new Pool({ connectionString: baseUrl, max: 8 })
  const db = new PgDatabase(pool)
  const loc = `cp_${process.pid}_${Math.floor(Math.random() * 1e9)}`
  await db.query('INSERT INTO locations (id, name, slug) VALUES ($1, $1, $1)', [loc])
  return { pool, db, loc }
}

function harness(db: PgDatabase, loc: string, send?: typeof sendCampaign) {
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('operatorId', 'op1')
    c.set('locationId', loc)
    await next()
  })
  app.route('/', campaignsRoute({ db, send }))
  return app
}

async function seedCampaign(db: PgDatabase, loc: string, phones: string[]): Promise<string> {
  for (const [i, phone] of phones.entries()) {
    await db.query(
      'INSERT INTO contacts (id, location_id, name, phones, emails) VALUES ($1,$2,$3,$4,$5)',
      [`cc_${i}_${loc}`, loc, `Blast ${i}`, [phone], []],
    )
  }
  const campaign = await new CampaignsRepo(db, loc).create({ name: 'Interleave blast', channel: 'sms', body: 'Hi {{name}}' })
  return campaign.id
}

test('R14-09: cancel mid-blast stops new attempts — in-flight outcome honored, rest pending, no markSent', async () => {
  const { pool, db, loc } = await setup()
  try {
    const id = await seedCampaign(db, loc, ['+15551230001', '+15551230002'])
    let gate: () => void = () => {}
    const gatePromise = new Promise<void>((resolve) => {
      gate = resolve
    })
    let sendCalls = 0
    const sender: SmsSender = {
      name: 'test-blocking',
      sendSms: async () => {
        sendCalls += 1
        if (sendCalls === 1) await gatePromise
        return { externalId: `test-${sendCalls}`, provider: 'test-blocking' }
      },
    }
    // The REAL loop with a blocking provider: cancellation is observed
    // through the production shouldStop path, not a fake.
    const wrappedSend = (deps: CampaignSendDeps, input: CampaignSendInput) =>
      sendCampaign({ ...deps, resolveSms: async () => ({ ok: true as const, sender }), sleep: async () => {}, throttleMs: 0 }, input)
    const app = harness(db, loc, wrappedSend)

    const sendPromise = app.request(`/${id}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'cp-interleave-1' },
    })
    // Wait for the first recipient to reach 'sending' (the in-flight call).
    const deadline = Date.now() + 30_000
    for (;;) {
      const rows = await db.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM campaign_recipients WHERE location_id = $1 AND campaign_id = $2 AND status = 'sending'",
        [loc, id],
      )
      if ((rows[0]?.n ?? 0) > 0) break
      if (Date.now() > deadline) throw new Error('first recipient never reached sending')
      await new Promise((r) => setTimeout(r, 50))
    }
    const cancel = await app.request(`/${id}/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' } })
    expect(cancel.status).toBe(200)
    gate()
    const send = await sendPromise
    expect(send.status).toBe(200)
    const body = (await send.json()) as { ok: boolean; cancelled?: boolean; delivery?: { sent?: number } }
    expect(body.ok).toBe(true)
    expect(body.cancelled).toBe(true)
    // Exactly one provider call: the in-flight attempt completed, the second
    // recipient was never attempted.
    expect(sendCalls).toBe(1)
    const recipients = await db.query<{ contact_id: string; status: string }>(
      'SELECT contact_id, status FROM campaign_recipients WHERE location_id = $1 AND campaign_id = $2',
      [loc, id],
    )
    const counts = new Map<string, number>()
    for (const r of recipients) counts.set(r.status, (counts.get(r.status) ?? 0) + 1)
    expect(counts.get('sent')).toBe(1)
    expect(counts.get('pending')).toBe(1)
    // Cancelled, never marked sent.
    const [campaign] = await db.query<{ status: string; sent_at: string | null }>(
      'SELECT status, sent_at FROM campaigns WHERE location_id = $1 AND id = $2',
      [loc, id],
    )
    expect(campaign?.status).toBe('cancelled')
    expect(campaign?.sent_at).toBeNull()
  } finally {
    await pool.end()
  }
})

test('R14-09: racing sends collapse at the atomic claim — one blast, one 409', async () => {
  const { pool, db, loc } = await setup()
  try {
    const id = await seedCampaign(db, loc, ['+15551230001'])
    const sender: SmsSender = {
      name: 'test-fast',
      sendSms: async () => ({ externalId: 'test-1', provider: 'test-fast' }),
    }
    const wrappedSend = (deps: CampaignSendDeps, input: CampaignSendInput) =>
      sendCampaign({ ...deps, resolveSms: async () => ({ ok: true as const, sender }), sleep: async () => {}, throttleMs: 0 }, input)
    const app = harness(db, loc, wrappedSend)
    const fire = (key: string) =>
      app.request(`/${id}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
      })
    const [a, b] = await Promise.all([fire('cp-twin-a'), fire('cp-twin-b')])
    const statuses = [a.status, b.status].sort()
    expect(statuses).toEqual([200, 409])
    const [campaign] = await db.query<{ status: string }>('SELECT status FROM campaigns WHERE location_id = $1 AND id = $2', [loc, id])
    expect(campaign?.status).toBe('sent')
  } finally {
    await pool.end()
  }
})

test('R14-09: cancel-before-send refuses the send as busy-cancelled, touching no recipient', async () => {
  const { pool, db, loc } = await setup()
  try {
    const id = await seedCampaign(db, loc, ['+15551230001'])
    const sender: SmsSender = {
      name: 'test-fast',
      sendSms: async () => ({ externalId: 'test-1', provider: 'test-fast' }),
    }
    const wrappedSend = (deps: CampaignSendDeps, input: CampaignSendInput) =>
      sendCampaign({ ...deps, resolveSms: async () => ({ ok: true as const, sender }), sleep: async () => {}, throttleMs: 0 }, input)
    const app = harness(db, loc, wrappedSend)
    const cancel = await app.request(`/${id}/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' } })
    expect(cancel.status).toBe(200)
    const send = await app.request(`/${id}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'cp-cancelled-1' },
    })
    expect(send.status).toBe(409)
    expect(await send.json()).toMatchObject({ error: expect.stringMatching(/cancel/i) })
    const recipients = await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM campaign_recipients WHERE location_id = $1 AND campaign_id = $2',
      [loc, id],
    )
    expect(recipients[0]?.n).toBe(0)
  } finally {
    await pool.end()
  }
})
