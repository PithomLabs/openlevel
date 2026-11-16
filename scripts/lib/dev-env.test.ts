/**
 * Unit tests for the shared dev-environment module (Prompt 31: P1-1, P2-1, P2-2, P2-4).
 * Pure logic — no sockets, no processes. Runs everywhere including the sandbox.
 */
import { describe, expect, test } from 'vitest'
import {
  DEFAULT_API_PORT,
  DEFAULT_HOST,
  DEFAULT_WEB_PORT,
  classifyBindError,
  describeBindFailure,
  endpointUrl,
  proxyTargetFor,
  resolveDevConfig,
} from './dev-env.mjs'

describe('resolveDevConfig defaults', () => {
  test('empty env takes all defaults', () => {
    expect(resolveDevConfig({})).toEqual({ host: '127.0.0.1', apiPort: 8790, webPort: 5273 })
  })

  test('default constants match the documented contract', () => {
    expect(DEFAULT_HOST).toBe('127.0.0.1')
    expect(DEFAULT_API_PORT).toBe(8790)
    expect(DEFAULT_WEB_PORT).toBe(5273)
  })
})

describe('resolveDevConfig port overrides', () => {
  test('API_PORT override applies, web keeps default', () => {
    expect(resolveDevConfig({ OPENLEVEL_API_PORT: '8899' })).toEqual({ host: '127.0.0.1', apiPort: 8899, webPort: 5273 })
  })

  test('WEB_PORT override applies, API keeps default', () => {
    expect(resolveDevConfig({ OPENLEVEL_WEB_PORT: '5280' })).toEqual({ host: '127.0.0.1', apiPort: 8790, webPort: 5280 })
  })

  test('both overrides together', () => {
    expect(resolveDevConfig({ OPENLEVEL_API_PORT: '8899', OPENLEVEL_WEB_PORT: '5280' })).toEqual({
      host: '127.0.0.1',
      apiPort: 8899,
      webPort: 5280,
    })
  })

  test('boundary ports 1 and 65535 are accepted', () => {
    expect(resolveDevConfig({ OPENLEVEL_API_PORT: '1' }).apiPort).toBe(1)
    expect(resolveDevConfig({ OPENLEVEL_API_PORT: '65535' }).apiPort).toBe(65535)
  })

  test('surrounding whitespace is tolerated', () => {
    expect(resolveDevConfig({ OPENLEVEL_API_PORT: ' 8080 ' }).apiPort).toBe(8080)
  })

  test.each(['0', '65536', '-1', '12.5', 'abc', '80x', '0x50', '  '])('invalid port %p is rejected, never ignored', (raw) => {
    expect(() => resolveDevConfig({ OPENLEVEL_API_PORT: raw })).toThrow(/not a valid port/)
    expect(() => resolveDevConfig({ OPENLEVEL_WEB_PORT: raw })).toThrow(/not a valid port/)
  })
})

describe('resolveDevConfig host allowlist', () => {
  test.each([
    ['127.0.0.1', '127.0.0.1'],
    ['::1', '::1'],
    ['[::1]', '::1'],
    ['localhost', '127.0.0.1'],
    ['LOCALHOST', '127.0.0.1'],
    [' localhost ', '127.0.0.1'],
  ])('host %p normalizes to %p', (raw, expected) => {
    expect(resolveDevConfig({ OPENLEVEL_HOST: raw }).host).toBe(expected)
  })

  test.each(['0.0.0.0', '::', '192.168.1.5', '10.0.0.1', 'example.com', 'localhost.', '[::1', 'foo bar', '999.1.1.1'])(
    'host %p is rejected with a loopback-only message',
    (raw) => {
      expect(() => resolveDevConfig({ OPENLEVEL_HOST: raw })).toThrow(/loopback only/)
    },
  )
})

describe('proxyTargetFor', () => {
  test('default target is exactly the IPv4 loopback API endpoint', () => {
    expect(proxyTargetFor({ host: '127.0.0.1', apiPort: 8790 })).toBe('http://127.0.0.1:8790')
  })

  test('API port override changes the proxy target', () => {
    expect(proxyTargetFor({ host: '127.0.0.1', apiPort: 8899 })).toBe('http://127.0.0.1:8899')
  })

  test('IPv6 loopback produces valid bracket syntax', () => {
    const target = proxyTargetFor({ host: '::1', apiPort: 8790 })
    expect(target).toBe('http://[::1]:8790')
    expect(new URL(target).hostname).toBe('[::1]')
  })

  test('proxy target never uses a wildcard or external interface', () => {
    for (const target of [
      proxyTargetFor({ host: '127.0.0.1', apiPort: 8790 }),
      proxyTargetFor({ host: '::1', apiPort: 8899 }),
    ]) {
      expect(target).not.toContain('0.0.0.0')
      expect(new URL(target).hostname).toMatch(/^(127\.0\.0\.1|\[::1\])$/)
    }
  })
})

describe('classifyBindError', () => {
  test('EADDRINUSE reports in-use', () => {
    expect(classifyBindError({ code: 'EADDRINUSE' })).toEqual({ kind: 'in-use', code: 'EADDRINUSE' })
  })

  test.each(['EPERM', 'EACCES'])('%s reports denied', (code) => {
    expect(classifyBindError({ code })).toEqual({ kind: 'denied', code })
  })

  test('EADDRNOTAVAIL reports unavailable', () => {
    expect(classifyBindError({ code: 'EADDRNOTAVAIL' })).toEqual({ kind: 'unavailable', code: 'EADDRNOTAVAIL' })
  })

  test('unknown codes and shapes report unknown with the real code', () => {
    expect(classifyBindError({ code: 'EPIPE' })).toEqual({ kind: 'unknown', code: 'EPIPE' })
    expect(classifyBindError({})).toEqual({ kind: 'unknown', code: 'unknown' })
    expect(classifyBindError(null)).toEqual({ kind: 'unknown', code: 'unknown' })
    expect(classifyBindError({ code: '' })).toEqual({ kind: 'unknown', code: 'unknown' })
  })
})

describe('describeBindFailure', () => {
  const base = { label: 'api', host: '127.0.0.1', port: 8790, owner: null as string | null }

  test('in-use names the occupant hint and the address', () => {
    expect(describeBindFailure({ ...base, kind: 'in-use', code: 'EADDRINUSE', owner: 'pid 123' })).toContain('already in use')
    expect(describeBindFailure({ ...base, kind: 'in-use', code: 'EADDRINUSE', owner: 'pid 123' })).toContain('pid 123')
  })

  test('in-use without owner has no empty hint', () => {
    expect(describeBindFailure({ ...base, kind: 'in-use', code: 'EADDRINUSE' })).toMatch(/8790 is already in use\.$/)
  })

  test('only in-use mentions another process', () => {
    for (const kind of ['denied', 'unavailable', 'unknown'] as const) {
      const text = describeBindFailure({ ...base, kind, code: 'X' })
      expect(text).not.toContain('already in use')
      expect(text).not.toContain('other process')
    }
  })

  test('each category carries its code and context', () => {
    expect(describeBindFailure({ ...base, kind: 'denied', code: 'EPERM' })).toMatch(/EPERM.*not permitted/)
    expect(describeBindFailure({ ...base, kind: 'unavailable', code: 'EADDRNOTAVAIL' })).toMatch(/EADDRNOTAVAIL.*not available/)
    expect(describeBindFailure({ ...base, kind: 'unknown', code: 'EPIPE' })).toMatch(/unexpected error EPIPE/)
  })
})

describe('export shape (d.ts drift guard)', () => {
  test('all documented exports exist with the right runtime types', () => {
    expect(typeof resolveDevConfig).toBe('function')
    expect(typeof proxyTargetFor).toBe('function')
    expect(typeof endpointUrl).toBe('function')
    expect(typeof classifyBindError).toBe('function')
    expect(typeof describeBindFailure).toBe('function')
  })
})

describe('endpointUrl (P2-N1: launcher URLs for every mode)', () => {
  test('IPv4 loopback produces exact endpoint strings', () => {
    expect(endpointUrl('127.0.0.1', 8790)).toBe('http://127.0.0.1:8790')
    expect(endpointUrl('127.0.0.1', 8899)).toBe('http://127.0.0.1:8899')
    expect(endpointUrl('127.0.0.1', 5280)).toBe('http://127.0.0.1:5280')
  })

  test('IPv6 loopback produces valid bracket syntax (never http://::1:port)', () => {
    expect(endpointUrl('::1', 8790)).toBe('http://[::1]:8790')
    expect(endpointUrl('::1', 5273)).toBe('http://[::1]:5273')
    expect(new URL(endpointUrl('::1', 8790)).hostname).toBe('[::1]')
  })

  test('every endpoint parses as a URL with the intended host and port', () => {
    for (const [host, port] of [['127.0.0.1', 8790], ['127.0.0.1', 8899], ['::1', 8790], ['::1', 5273]] as const) {
      const parsed = new URL(endpointUrl(host, port))
      expect(parsed.port).toBe(String(port))
      expect(parsed.hostname).toBe(host === '::1' ? '[::1]' : host)
    }
  })

  test('proxyTargetFor delegates to the same construction', () => {
    expect(proxyTargetFor({ host: '127.0.0.1', apiPort: 8790 })).toBe(endpointUrl('127.0.0.1', 8790))
    expect(proxyTargetFor({ host: '::1', apiPort: 8899 })).toBe(endpointUrl('::1', 8899))
  })
})
