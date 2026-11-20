import { execFile } from 'node:child_process'
import { createServer } from 'node:net'
import { join } from 'node:path'

const DEV = join(process.cwd(), 'scripts', 'dev.mjs')

function runHealth(env: Record<string, string>): Promise<{ code: number; out: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [DEV, 'health'],
      { env: { ...process.env, ...env }, timeout: 30000 },
      (err, stdout, stderr) => {
        if (err && (err as { killed?: boolean }).killed) return reject(err)
        resolve({ code: (err as { code?: number } | null)?.code ?? 0, out: `${stdout}${stderr}` })
      },
    )
  })
}

/** Reserve a port by holding it; resolves with the port number. */
function holdPort(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => socket.destroy())
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') return reject(new Error('no address'))
      resolve({ port: address.port, close: () => new Promise((r) => server.close(() => r())) })
    })
  })
}

/** Find a currently-free port (best effort; tiny reuse race accepted). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') return reject(new Error('no address'))
      const port = (address as { port: number }).port
      server.close(() => resolve(port))
    })
  })
}

test('health names the port holder when a side is DOWN-but-busy (onboarding claim)', async () => {
  const held = await holdPort()
  const free = await freePort()
  try {
    const { code, out } = await runHealth({
      OPENLEVEL_HOST: '127.0.0.1',
      OPENLEVEL_API_PORT: String(held.port),
      OPENLEVEL_WEB_PORT: String(free),
    })
    expect(code).toBe(1)
    const apiLine = out.split('\n').find((l) => l.startsWith('api '))
    expect(apiLine).toMatch(/DOWN/)
    // Either the holder identity (ss/lsof present) or an honest unknown.
    expect(apiLine).toMatch(/port held by|port busy, holder unknown/)
  } finally {
    await held.close()
  }
})

test('health reports plain DOWN with no holder when ports are free', async () => {
  const apiPort = await freePort()
  const webPort = await freePort()
  const { code, out } = await runHealth({
    OPENLEVEL_HOST: '127.0.0.1',
    OPENLEVEL_API_PORT: String(apiPort),
    OPENLEVEL_WEB_PORT: String(webPort),
  })
  expect(code).toBe(1)
  expect(out).toMatch(/api .* DOWN\n/)
  expect(out).not.toMatch(/held by|holder unknown/)
})
