/**
 * Shared dev-environment resolution (Prompt 31: P1-1, P2-1, P2-2, P2-4).
 * Pure, dependency-free, and import-safe (no side effects on import).
 * Single validation source for scripts/dev.mjs, scripts/toolchain.mjs,
 * server/dev-server.ts, vite.config.ts, and vitest.
 *
 * Environment contract:
 *   OPENLEVEL_HOST      loopback address (default 127.0.0.1)
 *   OPENLEVEL_API_PORT  API port (default 8790)
 *   OPENLEVEL_WEB_PORT  frontend port (default 5273)
 */

export const DEFAULT_HOST = '127.0.0.1'
export const DEFAULT_API_PORT = 8790
export const DEFAULT_WEB_PORT = 5273

function readPort(env, name, fallback) {
  const raw = env[name]
  if (raw === undefined || raw === null || raw === '') return fallback
  const text = String(raw).trim()
  if (!/^\d+$/.test(text)) {
    throw new Error(`${name}=${raw} is not a valid port (integer 1-65535)`)
  }
  const value = Number.parseInt(text, 10)
  if (value < 1 || value > 65535) {
    throw new Error(`${name}=${raw} is not a valid port (integer 1-65535)`)
  }
  return value
}

function readHost(env) {
  const raw = env.OPENLEVEL_HOST
  if (raw === undefined || raw === null || raw === '') return DEFAULT_HOST
  const text = String(raw).trim()
  if (text === '127.0.0.1') return '127.0.0.1'
  if (text === '::1' || text === '[::1]') return '::1'
  if (text.toLowerCase() === 'localhost') return DEFAULT_HOST
  throw new Error(
    `OPENLEVEL_HOST=${raw} is not permitted: development servers bind loopback only (127.0.0.1, ::1, or localhost)`,
  )
}

/**
 * Resolve + validate the effective dev configuration. Unset values take
 * defaults; set-but-invalid values throw (never silently ignored).
 */
export function resolveDevConfig(env = process.env) {
  return {
    host: readHost(env),
    apiPort: readPort(env, 'OPENLEVEL_API_PORT', DEFAULT_API_PORT),
    webPort: readPort(env, 'OPENLEVEL_WEB_PORT', DEFAULT_WEB_PORT),
  }
}

/**
 * Canonical `http://host:port` endpoint for any loopback host. WHATWG URL
 * construction keeps IPv6 bracket syntax correct without manual
 * concatenation (never `http://::1:port`).
 */
export function endpointUrl(host, port) {
  const url = new URL('http://127.0.0.1')
  // The hostname setter rejects bare IPv6 (colons need brackets); the URL
  // object still owns all serialization, so bracket syntax stays correct.
  const bare = host.replace(/^\[(.*)\]$/, '$1')
  url.hostname = bare.includes(':') ? `[${bare}]` : bare
  url.port = String(port)
  return `${url.protocol}//${url.host}`
}

/**
 * Canonical API endpoint URL for the Vite proxy. Delegates to the same
 * construction the launcher uses, so proxy and probes cannot diverge.
 */
export function proxyTargetFor(config) {
  return endpointUrl(config.host, config.apiPort)
}

/**
 * Classify a bind/probe errno. Never throws; unknown shapes report 'unknown'
 * with the real code (or 'unknown' when even that is missing).
 */
export function classifyBindError(err) {
  const code = typeof err?.code === 'string' && err.code !== '' ? err.code : 'unknown'
  if (code === 'EADDRINUSE') return { kind: 'in-use', code }
  if (code === 'EACCES' || code === 'EPERM') return { kind: 'denied', code }
  if (code === 'EADDRNOTAVAIL') return { kind: 'unavailable', code }
  return { kind: 'unknown', code }
}

/**
 * One consistent diagnosis line per category. Only 'in-use' mentions another
 * process; every other category reports the bind/probe failure with its code.
 */
export function describeBindFailure({ kind, code, label, host, port, owner }) {
  const where = `${label} ${host}:${port}`
  if (kind === 'in-use') {
    return `${where} is already in use${owner ? ` (${owner})` : ''}.`
  }
  if (kind === 'denied') {
    return `${where} cannot bind (${code}: operation not permitted in this environment).`
  }
  if (kind === 'unavailable') {
    return `${where} cannot bind (${code}: address not available on this host).`
  }
  return `${where} bind probe failed (unexpected error ${code}).`
}
