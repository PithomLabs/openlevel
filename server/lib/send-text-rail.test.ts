import { makeHttpSendText } from './send-text-rail'

/**
 * The HTTP rail that turns the operator assistant's approved text into a real
 * send by calling the nerve-survey gateway (which owns the Beeper credential, so
 * OpenLevel never sees it — D-36). The opposite contract from notify-push: this
 * AWAITS the gateway, parses its JSON body as the authoritative SendTextResult,
 * and NEVER swallows — confirming a text must report honestly whether it went out.
 */

/** A fake fetch that resolves a gateway-shaped JSON body + status. */
function fakeFetch(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue({ status, json: async () => body })
}

test('POSTs to the gateway with the internal-push secret + {e164, body, nonce, state}, parsing an ok result', async () => {
  const fetchImpl = fakeFetch({ ok: true, messageId: 'gw_msg_1' })
  const send = makeHttpSendText({ url: 'https://gw/text/send', secret: 'sek', fetchImpl })
  const result = await send('+16025551234', 'Hi Jane', 'nonce1', 'AZ')

  expect(result).toEqual({ ok: true, messageId: 'gw_msg_1' })
  expect(fetchImpl).toHaveBeenCalledWith(
    'https://gw/text/send',
    expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ 'x-internal-push-secret': 'sek', 'content-type': 'application/json' }),
    }),
  )
  // destination + body + nonce + state are sent verbatim. state is what the gateway
  // turns into the legal texting window, so it MUST ride along — the gateway is both
  // the dedup authority (nonce) and the legal authority (state).
  const init = fetchImpl.mock.calls[0]![1] as RequestInit
  expect(JSON.parse(String(init.body))).toEqual({ e164: '+16025551234', body: 'Hi Jane', nonce: 'nonce1', state: 'AZ' })
})

test('forwards an empty state when the contact has none, so the gateway can refuse it as unknown', async () => {
  const fetchImpl = fakeFetch({ ok: false, reason: 'unknown_state' }, 422)
  const send = makeHttpSendText({ url: 'https://gw/text/send', secret: 'sek', fetchImpl })
  const result = await send('+16025551234', 'Hi', 'n1', '')
  const init = fetchImpl.mock.calls[0]![1] as RequestInit
  expect(JSON.parse(String(init.body))).toEqual({ e164: '+16025551234', body: 'Hi', nonce: 'n1', state: '' })
  // and the gateway's unknown_state refusal passes back through verbatim, never a false ok
  expect(result).toEqual({ ok: false, reason: 'unknown_state' })
})

test('passes a deduped success through verbatim', async () => {
  const fetchImpl = fakeFetch({ ok: true, messageId: 'm9', deduped: true })
  const send = makeHttpSendText({ url: 'https://gw/text/send', secret: 'sek', fetchImpl })
  expect(await send('+16025551234', 'Hi', 'n1', 'AZ')).toEqual({ ok: true, messageId: 'm9', deduped: true })
})

test("passes the gateway's own failure reason through verbatim", async () => {
  for (const reason of ['outside_window', 'unknown_state', 'bad_phone', 'in_flight', 'not_configured', 'failed'] as const) {
    const fetchImpl = fakeFetch({ ok: false, reason }, 422)
    const send = makeHttpSendText({ url: 'https://gw/text/send', secret: 'sek', fetchImpl })
    expect(await send('+16025551234', 'Hi', 'n1', 'AZ')).toEqual({ ok: false, reason })
  }
})

test('maps a network error to failed — never throws, never claims sent', async () => {
  const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
  const send = makeHttpSendText({ url: 'https://gw/text/send', secret: 'sek', fetchImpl })
  const result = await send('+16025551234', 'Hi', 'n1', 'AZ')
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.reason).toBe('failed')
})

test('maps a non-JSON / unparseable gateway response to failed, never a false success', async () => {
  // e.g. a 502 HTML error page or a 401 plain-error body the rail does not recognise
  const fetchImpl = vi.fn().mockResolvedValue({
    status: 502,
    json: async () => {
      throw new SyntaxError('Unexpected token <')
    },
  })
  const send = makeHttpSendText({ url: 'https://gw/text/send', secret: 'sek', fetchImpl })
  expect(await send('+16025551234', 'Hi', 'n1', 'AZ')).toMatchObject({ ok: false, reason: 'failed' })
})

test('an ok body missing its messageId is treated as failed, never a false success', async () => {
  const fetchImpl = fakeFetch({ ok: true }) // malformed — no messageId
  const send = makeHttpSendText({ url: 'https://gw/text/send', secret: 'sek', fetchImpl })
  expect(await send('+16025551234', 'Hi', 'n1', 'AZ')).toMatchObject({ ok: false, reason: 'failed' })
})

test('returns not_configured when url or secret is unset, without calling fetch', async () => {
  const fetchImpl = vi.fn()
  for (const cfg of [
    { url: '', secret: 'sek', fetchImpl },
    { url: 'https://gw/text/send', secret: '', fetchImpl },
  ]) {
    expect(await makeHttpSendText(cfg)('+16025551234', 'Hi', 'n1', 'AZ')).toMatchObject({
      ok: false,
      reason: 'not_configured',
    })
  }
  expect(fetchImpl).not.toHaveBeenCalled()
})

test('R14-03: staging refuses EVERYTHING at the rail with zero gateway contact (no live fetch)', async () => {
  // The rail carries no location/db context, so it cannot sink — it refuses,
  // even for allowlisted numbers. Staging sink-first lives in the caller
  // (confirmOperatorWrite), which never consults the rail in staging.
  const fetchImpl = fakeFetch({ ok: true, messageId: 'gw_msg_1' })
  const env = { APP_ENV: 'staging', STAGING_SINK_ALLOWLIST: '+16025551234' }
  const send = makeHttpSendText({ url: 'https://gw/text/send', secret: 'sek', fetchImpl, env })
  expect(await send('+16025551234', 'Hi', 'n1', 'AZ')).toMatchObject({ ok: false, reason: 'refused' })
  expect(await send('+19998887777', 'Hi', 'n2', 'AZ')).toMatchObject({ ok: false, reason: 'refused' })
  expect(fetchImpl).not.toHaveBeenCalled()
})

test('R14-03: restricted production preview refuses with zero gateway contact', async () => {
  const fetchImpl = fakeFetch({ ok: true, messageId: 'gw_msg_1' })
  const send = makeHttpSendText({
    url: 'https://gw/text/send',
    secret: 'sek',
    fetchImpl,
    env: { APP_ENV: 'production', RESTRICTED_PREVIEW: 'true' },
  })
  const result = await send('+16025551234', 'Hi', 'n1', 'AZ')
  expect(result).toMatchObject({ ok: false, reason: 'refused' })
  expect(fetchImpl).not.toHaveBeenCalled()
})

test('R14-03: malformed environment identity refuses with zero gateway contact', async () => {
  const fetchImpl = fakeFetch({ ok: true, messageId: 'gw_msg_1' })
  const send = makeHttpSendText({
    url: 'https://gw/text/send',
    secret: 'sek',
    fetchImpl,
    env: { APP_ENV: 'prod' },
  })
  expect(await send('+16025551234', 'Hi', 'n1', 'AZ')).toMatchObject({ ok: false, reason: 'refused' })
  expect(fetchImpl).not.toHaveBeenCalled()
})

test('staging fence: a missing allowlist refuses everything (fail-closed)', async () => {
  const fetchImpl = vi.fn()
  const send = makeHttpSendText({
    url: 'https://gw/text/send',
    secret: 'sek',
    fetchImpl,
    env: { APP_ENV: 'staging' },
  })
  expect(await send('+16025551234', 'Hi', 'n1', 'AZ')).toMatchObject({ ok: false, reason: 'refused' })
  expect(fetchImpl).not.toHaveBeenCalled()
})
