/**
 * Launcher pre-spawn rejection (Prompt 31: P1-1, P2-4). Invalid config must
 * fail before children start — no sockets touched, sandbox-safe.
 */
import { execFileSync } from 'node:child_process'
import { describe, expect, test } from 'vitest'

function runDev(args: string[], env: Record<string, string>): { status: number | null; output: string } {
  try {
    const out = execFileSync(process.execPath, ['scripts/dev.mjs', ...args], {
      env: { ...process.env, ...env },
      encoding: 'utf8',
      timeout: 30000,
    })
    return { status: 0, output: out }
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string }
    return { status: e.status ?? null, output: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

function runLauncher(env: Record<string, string>): { status: number | null; output: string } {
  return runDev([], env)
}

function expectNoSpawn(output: string): void {
  expect(output).not.toMatch(/\[api\]|\[web\]|Waiting for backend/)
}

describe('host rejection', () => {
  test.each(['0.0.0.0', '::', '192.168.1.5', 'example.com'])('LOOPBACK=%p is rejected as non-loopback before spawn', (host) => {
    const r = runLauncher({ OPENLEVEL_HOST: host })
    expect(r.status).toBe(1)
    expect(r.output).toMatch(/loopback only/)
    expectNoSpawn(r.output)
  })
})

describe('port rejection', () => {
  test.each(['OPENLEVEL_API_PORT', 'OPENLEVEL_WEB_PORT'])('invalid %p is rejected before spawn', (name) => {
    const r = runLauncher({ [name]: 'not-a-port' })
    expect(r.status).toBe(1)
    expect(r.output).toMatch(/not a valid port/)
    expectNoSpawn(r.output)
  })
})

describe('IPv6 modes (P2-N1)', () => {
  test('health mode probes bracketed endpoints without crashing', () => {
    const r = runDev(['health'], { OPENLEVEL_HOST: '::1' })
    expect(r.status).toBe(1)
    expect(r.output).toContain('http://[::1]:8790/health')
    expect(r.output).toContain('http://[::1]:5273')
    expect(r.output).not.toMatch(/http:\/\/::1:/)
  })

  test('health mode default path still uses IPv4 loopback', () => {
    const r = runDev(['health'], {})
    expect(r.status).toBe(1)
    expect(r.output).toContain('http://127.0.0.1:8790/health')
  })

  test('open mode prints the bracketed URL without opening a browser', () => {
    const r = runDev(['open'], { OPENLEVEL_HOST: '::1', NO_BROWSER: '1' })
    expect(r.status).toBe(0)
    expect(r.output).toContain('http://[::1]:5273')
  })
})
