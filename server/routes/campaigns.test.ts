import { Hono } from 'hono'
import { vi } from 'vitest'
import type { AppEnv } from '../app-env'
import { FakeDatabase } from '../db/fake-database'
import { payloadHash } from '../lib/idempotency'
import type { sendCampaign } from '../lib/sending/campaign-send'
import { campaignsRoute } from './campaigns'

function harness(db: FakeDatabase, locationId = 'locA', send?: typeof sendCampaign) {
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('operatorId', 'op1')
    c.set('locationId', locationId)
    await next()
  })
  app.route('/', campaignsRoute({ db, send }))
  return app
}

/** A send engine that reports every contact delivered. */
function allSentEngine(contactIds: string[]) {
  return vi.fn<typeof sendCampaign>(async () => ({
    ok: true as const,
    outcomes: contactIds.map((id) => ({ contactId: id, status: 'sent' as const, detail: null })),
    sentCount: contactIds.length,
    simulated: false,
    cancelled: false,
  }))
}

function postJson(app: Hono<AppEnv>, path: string, body: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

test('GET / lists campaigns scoped to the location', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: 'cmp1', location_id: 'locA', name: 'Spring blast' }])
  const res = await harness(db).request('/')

  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ campaigns: [{ id: 'cmp1', location_id: 'locA', name: 'Spring blast' }] })
  expect(db.calls[0]?.params).toEqual(['locA'])
})

test('POST / creates a draft (201) with location_id set', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: 'cmp_new', location_id: 'locA', name: 'Cash offer', status: 'draft' }])
  const res = await postJson(harness(db), '/', { name: 'Cash offer', body: 'We buy houses' })

  expect(res.status).toBe(201)
  expect(await res.json()).toMatchObject({ ok: true, campaign: { id: 'cmp_new', status: 'draft' } })
  expect(db.calls[0]?.params[0]).toBe('locA')
})

test('POST / rejects an empty name (400)', async () => {
  const db = new FakeDatabase()
  const res = await postJson(harness(db), '/', { name: '', body: 'hi' })
  expect(res.status).toBe(400)
})

test('POST / rejects an empty body (400)', async () => {
  const db = new FakeDatabase()
  const res = await postJson(harness(db), '/', { name: 'No body', body: '' })
  expect(res.status).toBe(400)
})

test('GET /:id returns the campaign with its recipients', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: 'cmp1', location_id: 'locA', name: 'Spring blast' }]) // campaign
  db.enqueue([{ id: 'r1', campaign_id: 'cmp1' }]) // recipients
  const res = await harness(db).request('/cmp1')

  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({
    campaign: { id: 'cmp1', location_id: 'locA', name: 'Spring blast' },
    recipients: [{ id: 'r1', campaign_id: 'cmp1' }],
  })
  expect(db.calls[0]?.params).toEqual(['locA', 'cmp1']) // get campaign
  expect(db.calls[1]?.params).toEqual(['locA', 'cmp1']) // recipients by campaign
})

test('GET /:id is 404 when the campaign is not in this location', async () => {
  const db = new FakeDatabase()
  db.enqueue([]) // get -> none
  const res = await harness(db).request('/missing')
  expect(res.status).toBe(404)
})

test('POST /:id/send blasts a draft through the send engine and marks it sent (200)', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: 'cmp1', status: 'draft', audience_tag: null }]) // get campaign
  db.enqueue([{ id: 'c1' }, { id: 'c2' }]) // contacts list
  db.enqueue([{ key: 'k1' }]) // idempotency claim INSERT
  db.enqueue([{ id: 'cmp1', status: 'sending', audience_tag: null }]) // claimForSend RETURNING
  db.enqueue([]) // markPending (no rows needed)
  db.enqueue([]) // sentContactIds -> none yet
  db.enqueue([]) // completedContactIds -> none
  db.enqueue([]) // sendingContactIds -> none quarantined
  db.enqueue([]) // custom values map
  db.enqueue([{ id: 'cmp1', status: 'sent', sent_count: 2 }]) // markSent RETURNING
  const send = allSentEngine(['c1', 'c2'])

  const res = await harness(db, 'locA', send).request('/cmp1/send', {
    method: 'POST',
    headers: { 'Idempotency-Key': 'k1' },
  })

  expect(res.status).toBe(200)
  expect(await res.json()).toMatchObject({
    ok: true,
    campaign: { status: 'sent' },
    delivery: { sent: 2, skipped: 0, failed: 0, quarantined: 0 },
    simulated: false,
  })
  // The engine received the audience it must fan out to.
  expect(send).toHaveBeenCalledTimes(1)
  expect(send.mock.calls[0]?.[1]).toMatchObject({
    locationId: 'locA',
    contacts: [{ id: 'c1' }, { id: 'c2' }],
  })
  // markSent records [location, recipientCount, sentCount, id].
  const markSent = db.calls.find((c) => /SET status='sent'/i.test(c.sql))
  expect(markSent?.params).toEqual(['locA', 2, 2, 'cmp1'])
  // The claim is atomic: single UPDATE gated on draft-or-stale-sending.
  const claim = db.calls.find((c) => /SET status='sending'/i.test(c.sql))
  expect(claim?.sql).toMatch(/status='draft'/)
})

test('N5: resume quarantines stuck-sending recipients instead of resending (uncertain outcome)', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: 'cmp1', status: 'draft', audience_tag: null }]) // get campaign
  db.enqueue([{ id: 'c1' }, { id: 'c2' }]) // contacts list
  db.enqueue([{ key: 'k1' }]) // idempotency claim INSERT
  db.enqueue([{ id: 'cmp1', status: 'sending' }]) // claimForSend RETURNING
  db.enqueue([]) // markPending
  db.enqueue([]) // sentContactIds -> none confirmed
  db.enqueue([]) // completedContactIds -> none
  db.enqueue([{ contact_id: 'c1' }]) // sendingContactIds -> c1 died mid-send
  db.enqueue([]) // custom values map
  db.enqueue([{ id: 'cmp1', status: 'sent', sent_count: 1 }]) // markSent RETURNING
  const send = allSentEngine(['c2'])

  const res = await harness(db, 'locA', send).request('/cmp1/send', {
    method: 'POST',
    headers: { 'Idempotency-Key': 'k1' },
  })

  expect(res.status).toBe(200)
  expect(await res.json()).toMatchObject({ delivery: { sent: 1, quarantined: 1 } })
  // The engine never saw the quarantined contact: no second provider call.
  expect(send.mock.calls[0]?.[1]).toMatchObject({ contacts: [{ id: 'c2' }] })
})

test('POST /:id/send is an honest 409 when no provider is connected (stays claimable)', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: 'cmp1', status: 'draft', audience_tag: null }]) // get campaign
  db.enqueue([{ id: 'c1' }]) // contacts list
  db.enqueue([{ key: 'k1' }]) // idempotency claim INSERT
  db.enqueue([{ id: 'cmp1', status: 'sending' }]) // claimForSend RETURNING
  db.enqueue([{ id: 'cmp1', status: 'draft' }]) // releaseClaim RETURNING
  const send = vi.fn(async () => ({ ok: false as const, reason: 'no email provider connected' }))

  const res = await harness(db, 'locA', send).request('/cmp1/send', {
    method: 'POST',
    headers: { 'Idempotency-Key': 'k1' },
  })

  expect(res.status).toBe(409)
  expect(await res.json()).toEqual({ error: 'no email provider connected' })
  // No markSent — the failure happened before completion.
  expect(db.calls.some((c) => /SET status='sent'/i.test(c.sql))).toBe(false)
})

test('R13-11: refusal releases the claim back to retryable draft immediately', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: 'cmp1', status: 'draft', audience_tag: null }]) // get campaign
  db.enqueue([{ id: 'c1' }]) // contacts list
  db.enqueue([{ key: 'k1' }]) // idempotency claim INSERT
  db.enqueue([{ id: 'cmp1', status: 'sending' }]) // claimForSend RETURNING
  db.enqueue([{ id: 'cmp1', status: 'draft' }]) // releaseClaim RETURNING
  const send = vi.fn(async () => ({ ok: false as const, reason: 'no email provider connected' }))

  const res = await harness(db, 'locA', send).request('/cmp1/send', {
    method: 'POST',
    headers: { 'Idempotency-Key': 'k1' },
  })

  expect(res.status).toBe(409)
  const release = db.calls.find((c) => /SET status='draft'/i.test(c.sql))
  expect(release?.sql).toMatch(/AND status='sending'/i)
})

test('R13-11: a cancelled send returns partial outcomes without markSent', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: 'cmp1', status: 'draft', audience_tag: null }]) // get campaign
  db.enqueue([{ id: 'c1' }, { id: 'c2' }]) // contacts list
  db.enqueue([{ key: 'k1' }]) // idempotency claim INSERT
  db.enqueue([{ id: 'cmp1', status: 'sending' }]) // claimForSend RETURNING
  db.enqueue([]) // markPending
  db.enqueue([]) // sentContactIds
  db.enqueue([]) // completedContactIds -> none
  db.enqueue([]) // sendingContactIds
  db.enqueue([]) // custom values map
  db.enqueue([{ id: 'cmp1', status: 'cancelled' }]) // re-read after stop
  const send = vi.fn(async () => ({
    ok: true as const,
    outcomes: [{ contactId: 'c1', status: 'sent' as const, detail: null }],
    sentCount: 1,
    simulated: false,
    cancelled: true,
  }))

  const res = await harness(db, 'locA', send).request('/cmp1/send', {
    method: 'POST',
    headers: { 'Idempotency-Key': 'k1' },
  })

  expect(res.status).toBe(200)
  expect(await res.json()).toMatchObject({ cancelled: true, delivery: { sent: 1 } })
  expect(db.calls.some((c) => /SET status='sent'/i.test(c.sql))).toBe(false)
})

test('R13-11: sending a cancelled campaign refuses as already-cancelled (not busy)', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: 'cmp1', status: 'cancelled', audience_tag: null }]) // get campaign
  db.enqueue([{ id: 'c1' }]) // contacts list
  db.enqueue([{ key: 'k1' }]) // idempotency claim INSERT
  db.enqueue([]) // claimForSend -> lost (cancelled is terminal)
  db.enqueue([{ id: 'cmp1', status: 'cancelled' }]) // status re-read

  const res = await harness(db, 'locA', allSentEngine(['c1'])).request('/cmp1/send', {
    method: 'POST',
    headers: { 'Idempotency-Key': 'k1' },
  })

  expect(res.status).toBe(409)
  expect(await res.json()).toEqual({ error: 'campaign was cancelled' })
})

test('R13-07: simulated outcomes count separately and resume skips them without resending', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: 'cmp1', status: 'draft', audience_tag: null }]) // get campaign
  db.enqueue([{ id: 'c1' }, { id: 'c2' }]) // contacts list
  db.enqueue([{ key: 'k1' }]) // idempotency claim INSERT
  db.enqueue([{ id: 'cmp1', status: 'sending' }]) // claimForSend RETURNING
  db.enqueue([]) // markPending
  db.enqueue([]) // sentContactIds -> none real
  db.enqueue([{ contact_id: 'c1' }]) // completedContactIds -> c1 simulated before
  db.enqueue([]) // sendingContactIds
  db.enqueue([]) // custom values map
  db.enqueue([{ id: 'cmp1', status: 'sent', sent_count: 0 }]) // markSent RETURNING
  const send = vi.fn<typeof sendCampaign>(async () => ({
    ok: true as const,
    outcomes: [{ contactId: 'c2', status: 'simulated' as const, detail: null }],
    sentCount: 0,
    simulated: true,
    cancelled: false,
  }))

  const res = await harness(db, 'locA', send).request('/cmp1/send', {
    method: 'POST',
    headers: { 'Idempotency-Key': 'k1' },
  })

  expect(res.status).toBe(200)
  expect(await res.json()).toMatchObject({ delivery: { sent: 0, simulated: 1 }, simulated: true })
  // The engine never saw the previously-simulated contact: resume skips it.
  expect(send.mock.calls[0]?.[1]).toMatchObject({ contacts: [{ id: 'c2' }] })
})

test('R13-11: cancel endpoint transitions draft/sending, refuses terminal and missing', async () => {
  const draft = new FakeDatabase()
  draft.enqueue([{ id: 'cmp1', status: 'draft' }]) // get
  draft.enqueue([{ id: 'cmp1', status: 'cancelled' }]) // cancel RETURNING
  const ok = await harness(draft).request('/cmp1/cancel', { method: 'POST' })
  expect(ok.status).toBe(200)
  expect(await ok.json()).toMatchObject({ ok: true, campaign: { status: 'cancelled' } })

  const sent = new FakeDatabase()
  sent.enqueue([{ id: 'cmp1', status: 'sent' }])
  expect((await harness(sent).request('/cmp1/cancel', { method: 'POST' })).status).toBe(409)

  const gone = new FakeDatabase()
  gone.enqueue([])
  expect((await harness(gone).request('/cmp1/cancel', { method: 'POST' })).status).toBe(404)
})

test('POST /:id/send records real outcomes and counts only delivered sends', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: 'cmp1', status: 'draft', audience_tag: null }]) // get campaign
  db.enqueue([{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }]) // contacts list
  db.enqueue([{ key: 'k1' }]) // idempotency claim INSERT
  db.enqueue([{ id: 'cmp1', status: 'sending' }]) // claimForSend RETURNING
  db.enqueue([]) // markPending
  db.enqueue([]) // sentContactIds -> none yet
  db.enqueue([]) // completedContactIds -> none
  db.enqueue([]) // sendingContactIds -> none quarantined
  db.enqueue([]) // custom values map
  db.enqueue([{ id: 'cmp1', status: 'sent', sent_count: 1 }]) // markSent RETURNING
  const send = vi.fn(async () => ({
    ok: true as const,
    outcomes: [
      { contactId: 'c1', status: 'sent' as const, detail: null },
      { contactId: 'c2', status: 'skipped' as const, detail: 'unsubscribed' },
      { contactId: 'c3', status: 'failed' as const, detail: 'brevo send failed: 500' },
    ],
    sentCount: 1,
    simulated: false,
    cancelled: false,
  }))

  const res = await harness(db, 'locA', send).request('/cmp1/send', {
    method: 'POST',
    headers: { 'Idempotency-Key': 'k1' },
  })

  expect(res.status).toBe(200)
  expect(await res.json()).toMatchObject({ delivery: { sent: 1, skipped: 1, failed: 1 } })
  // recipient_count = audience (3), sent_count = actually delivered (1).
  const markSent = db.calls.find((c) => /SET status='sent'/i.test(c.sql))
  expect(markSent?.params).toEqual(['locA', 3, 1, 'cmp1'])
})

test('POST /:id/send segments by audience_tag when set', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: 'cmp1', status: 'draft', audience_tag: 'seller' }]) // get campaign
  db.enqueue([{ id: 'c1' }]) // listByTag('seller')
  db.enqueue([{ key: 'k1' }]) // idempotency claim INSERT
  db.enqueue([{ id: 'cmp1', status: 'sending' }]) // claimForSend RETURNING
  db.enqueue([]) // markPending
  db.enqueue([]) // sentContactIds
  db.enqueue([]) // completedContactIds -> none
  db.enqueue([]) // sendingContactIds -> none quarantined
  db.enqueue([]) // custom values map
  db.enqueue([{ id: 'cmp1', status: 'sent', sent_count: 1 }]) // markSent RETURNING

  const res = await harness(db, 'locA', allSentEngine(['c1'])).request('/cmp1/send', {
    method: 'POST',
    headers: { 'Idempotency-Key': 'k1' },
  })

  expect(res.status).toBe(200)
  // audience query is the tag-membership lookup, scoped to location + tag.
  expect(db.calls[1]?.sql).toMatch(/\$2 = ANY\(tags\)/i)
  expect(db.calls[1]?.params).toEqual(['locA', 'seller'])
})

test('POST /:id/send is 404 when the campaign is missing', async () => {
  const db = new FakeDatabase()
  db.enqueue([]) // get -> none
  const res = await harness(db).request('/missing/send', { method: 'POST' })
  expect(res.status).toBe(404)
})

test('POST /:id/send is 409 when the campaign is already sent', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: 'cmp1', status: 'sent', audience_tag: null }]) // get campaign
  db.enqueue([{ id: 'c1' }]) // contacts list (non-empty so we reach the claim)
  db.enqueue([{ key: 'k1' }]) // idempotency claim INSERT
  db.enqueue([]) // claimForSend -> lost (already sent)
  db.enqueue([{ id: 'cmp1', status: 'sent' }]) // re-read for the message
  const res = await harness(db).request('/cmp1/send', {
    method: 'POST',
    headers: { 'Idempotency-Key': 'k1' },
  })
  expect(res.status).toBe(409)
  expect(await res.json()).toEqual({ error: 'campaign already sent' })
})

test('POST /:id/send is 409 when a twin holds the claim (FIND-07)', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: 'cmp1', status: 'sending', audience_tag: null }]) // get campaign
  db.enqueue([{ id: 'c1' }]) // contacts list
  db.enqueue([{ key: 'k1' }]) // idempotency claim INSERT
  db.enqueue([]) // claimForSend -> lost (twin sending)
  db.enqueue([{ id: 'cmp1', status: 'sending' }]) // re-read for the message
  const res = await harness(db).request('/cmp1/send', {
    method: 'POST',
    headers: { 'Idempotency-Key': 'k1' },
  })
  expect(res.status).toBe(409)
  expect(await res.json()).toEqual({ error: 'campaign send already in progress' })
})

test('POST /:id/send replays the recorded summary for a repeated key (FIND-07)', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: 'cmp1', status: 'sent', audience_tag: null }]) // get campaign
  db.enqueue([{ id: 'c1' }]) // contacts list
  db.enqueue([]) // idempotency INSERT -> conflict (key seen)
  db.enqueue([
    {
      payload_hash: payloadHash({ campaignId: 'cmp1' }),
      status: 'completed',
      result: { ok: true, campaign: { id: 'cmp1', status: 'sent' }, delivery: { sent: 1, skipped: 0, failed: 0 } },
      updated_at: new Date().toISOString(),
    },
  ]) // idempotency SELECT -> completed with the matching hash
  const send = allSentEngine(['c1'])
  const res = await harness(db, 'locA', send).request('/cmp1/send', {
    method: 'POST',
    headers: { 'Idempotency-Key': 'k1' },
  })
  expect(res.status).toBe(200)
  expect(await res.json()).toMatchObject({ ok: true, deduped: true, delivery: { sent: 1 } })
  expect(send).not.toHaveBeenCalled() // replayed, never re-executed
})

test('POST /:id/send conflicts when the key is reused for another campaign (FIND-07)', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: 'cmp2', status: 'draft', audience_tag: null }]) // get campaign
  db.enqueue([{ id: 'c1' }]) // contacts list
  db.enqueue([]) // idempotency INSERT -> conflict (key seen)
  db.enqueue([
    {
      payload_hash: payloadHash({ campaignId: 'cmp1' }), // recorded for ANOTHER campaign
      status: 'completed',
      result: { ok: true },
      updated_at: new Date().toISOString(),
    },
  ])
  const res = await harness(db, 'locA', allSentEngine(['c1'])).request('/cmp2/send', {
    method: 'POST',
    headers: { 'Idempotency-Key': 'k1' },
  })
  expect(res.status).toBe(409)
  expect(await res.json()).toMatchObject({ error: expect.stringMatching(/different .* payload/) })
})

test('POST /:id/send is 400 when the audience resolves to zero contacts', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: 'cmp1', status: 'draft', audience_tag: 'nobody' }]) // get campaign
  db.enqueue([]) // listByTag -> none
  const res = await harness(db).request('/cmp1/send', { method: 'POST' })
  expect(res.status).toBe(400)
})
