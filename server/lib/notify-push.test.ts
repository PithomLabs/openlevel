import { notifyPush } from './notify-push'

test('POSTs to the gateway with the internal secret header + full body', async () => {
  const fetchImpl = vi.fn().mockResolvedValue({ ok: true })
  await notifyPush({ url: 'http://gw/push/send', secret: 's3cret', fetchImpl }, {
    source: 'openlevel',
    title: 'New message — Bob',
    body: 'hello',
    data: { conversationId: 'conv1', locationId: 'locAlex' },
  })
  expect(fetchImpl).toHaveBeenCalledWith(
    'http://gw/push/send',
    expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ 'x-internal-push-secret': 's3cret' }),
    }),
  )
  const init = fetchImpl.mock.calls[0]![1] as RequestInit
  expect(JSON.parse(String(init.body))).toEqual({
    source: 'openlevel',
    title: 'New message — Bob',
    body: 'hello',
    data: { conversationId: 'conv1', locationId: 'locAlex' },
  })
})

test('never throws when the gateway is down (fire-and-forget)', async () => {
  const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
  await expect(
    notifyPush({ url: 'http://gw/push/send', secret: 's', fetchImpl }, {
      source: 'openlevel',
      title: 'x',
      body: 'y',
    }),
  ).resolves.toBe('sent')
})

test('is a no-op when url or secret is unset', async () => {
  const fetchImpl = vi.fn()
  await notifyPush({ url: '', secret: '', fetchImpl }, { source: 'openlevel', title: 'x', body: 'y' })
  expect(fetchImpl).not.toHaveBeenCalled()
})

test('R13-03: staging suppresses the push (no gateway call) with an explicit, PII-free outcome', async () => {
  const fetchImpl = vi.fn()
  const lines: string[] = []
  const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => void lines.push(String(args[0])))
  try {
    const outcome = await notifyPush(
      { url: 'http://gw/push/send', secret: 's', fetchImpl, env: { APP_ENV: 'staging' } },
      { source: 'openlevel', title: 'New message — Bob', body: 'hello' },
    )
    expect(outcome).toBe('suppressed-staging')
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(lines.join('\n')).toMatch(/push suppressed in staging/)
    expect(lines.join('\n')).not.toMatch(/Bob|hello/)
  } finally {
    log.mockRestore()
  }
})

test('R14-03: restricted production preview suppresses the push with its own explicit outcome', async () => {
  const fetchImpl = vi.fn()
  const lines: string[] = []
  const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => void lines.push(String(args[0])))
  try {
    const outcome = await notifyPush(
      {
        url: 'http://gw/push/send',
        secret: 's',
        fetchImpl,
        env: { APP_ENV: 'production', RESTRICTED_PREVIEW: 'true' },
      },
      { source: 'openlevel', title: 'New message — Bob', body: 'hello' },
    )
    expect(outcome).toBe('suppressed-preview')
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(lines.join('\n')).toMatch(/push suppressed/)
    expect(lines.join('\n')).not.toMatch(/Bob|hello/)
  } finally {
    log.mockRestore()
  }
})

