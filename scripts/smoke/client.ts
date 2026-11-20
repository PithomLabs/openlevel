/**
 * Smoke-runner client plumbing (R14-05): cookie-jar HTTP, read-only-ish SQL
 * across local pg and `neon sql`, and redacted shell execution.
 *
 * SQL discipline: fixture reads/writes use parameterized queries locally.
 * Remote SQL goes through `neon sql` (literal text only), so every remote
 * statement is built from runner-generated identifiers validated against
 * [a-z0-9_-]+ — never interpolated user input. Only non-secret columns are
 * ever selected (counts, ids, channels, statuses); secret stores are never
 * queried and connection strings never printed.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { redact } from './redact'

const execFileAsync = promisify(execFile)

export interface ShellResult {
  stdout: string
  stderr: string
}

/** Run a command; log the REDACTED command line to the transcript lines. */
export async function sh(
  transcript: (line: string) => void,
  cmd: string,
  args: string[],
  opts: { timeoutMs?: number } = {},
): Promise<ShellResult> {
  transcript(`$ ${redact([cmd, ...args].join(' '))}`)
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      timeout: opts.timeoutMs ?? 120_000,
      maxBuffer: 8 * 1024 * 1024,
    })
    return { stdout, stderr }
  } catch (err) {
    // Node's exec error echoes the full command (which may carry secrets
    // as env values) — redact before it can reach the transcript.
    const message = redact(err instanceof Error ? err.message : String(err))
    throw new Error(message)
  }
}

export interface HttpResult {
  status: number
  text: string
  json: unknown
}

/** Minimal cookie-jar HTTP client over undici fetch (Node 26 global). */
export class SmokeClient {
  private cookies = new Map<string, string>()
  constructor(readonly baseUrl: string) {}

  private storeCookies(res: Response): void {
    const setCookies = res.headers.getSetCookie?.() ?? []
    for (const line of setCookies) {
      const pair = line.split(';')[0] ?? ''
      const eq = pair.indexOf('=')
      if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim())
    }
  }

  private cookieHeader(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
  }

  async request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<HttpResult> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(this.cookies.size > 0 ? { cookie: this.cookieHeader() } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    })
    this.storeCookies(res)
    const text = await res.text()
    let json: unknown = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = null
    }
    return { status: res.status, text, json }
  }

  /** POST with a caller-supplied exact body (webhook HMAC signing needs byte control). */
  async postRaw(path: string, rawBody: string, headers: Record<string, string> = {}): Promise<HttpResult> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.cookies.size > 0 ? { cookie: this.cookieHeader() } : {}),
        ...headers,
      },
      body: rawBody,
      redirect: 'manual',
    })
    this.storeCookies(res)
    const text = await res.text()
    let json: unknown = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = null
    }
    return { status: res.status, text, json }
  }

  get(path: string, headers?: Record<string, string>): Promise<HttpResult> {
    return this.request('GET', path, undefined, headers)
  }
  post(path: string, body?: unknown, headers?: Record<string, string>): Promise<HttpResult> {
    return this.request('POST', path, body, headers)
  }
  patch(path: string, body?: unknown, headers?: Record<string, string>): Promise<HttpResult> {
    return this.request('PATCH', path, body, headers)
  }
}

const SAFE_IDENT = /^[a-z0-9][a-z0-9_-]*$/i

export function assertSafeIdent(value: string): void {
  if (!SAFE_IDENT.test(value) || value.length > 80) throw new Error(`unsafe SQL identifier: ${value}`)
}

/** SQL access for fixture setup/verification/cleanup. */
export interface SmokeSql {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>
  close(): Promise<void>
}

/** Local loopback Postgres via the pg driver (DATABASE_URL must be loopback). */
export async function localSql(databaseUrl: string): Promise<SmokeSql> {
  const { assertLoopbackDatabaseUrl } = await import('../../server/lib/db-identity')
  assertLoopbackDatabaseUrl(databaseUrl)
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: databaseUrl })
  return {
    query: async <T>(sql: string, params: unknown[] = []) => {
      const res = await pool.query(sql, params as unknown[])
      return res.rows as T[]
    },
    close: async () => {
      await pool.end()
    },
  }
}

/**
 * Remote read/write SQL via the Neon CLI (`neon psql` with passthrough
 * args — there is no `neon sql` in CLI 9.x). Literal statements only:
 * params are inlined after strict validation (strings get quoted
 * literals, numbers pass through, objects become jsonb, anything else
 * throws). SELECTs are wrapped in json_agg for machine-readable rows;
 * writes run bare (results ignored).
 */
export function neonSql(
  transcript: (line: string) => void,
  projectId: string,
  branch?: string,
): SmokeSql {
  assertSafeIdent(projectId)
  if (branch !== undefined) assertSafeIdent(branch)
  const inline = (sql: string, params: unknown[]): string => {
    // Validate placeholders against the ORIGINAL sql: literals (argon
    // hashes, emails) may themselves contain '$<digit>', so scanning the
    // substituted text would false-positive.
    const found = new Set([...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])))
    for (let i = 1; i <= params.length; i++) {
      if (!found.has(i)) throw new Error(`neon sql: param $${i} has no placeholder`)
    }
    for (const f of found) {
      if (f < 1 || f > params.length) throw new Error(`neon sql: placeholder $${f} has no param`)
    }
    const literal = (p: unknown, n: number): string => {
      if (typeof p === 'number' && Number.isFinite(p)) return String(p)
      if (typeof p === 'string') {
        if (p.length > 500) throw new Error('neon sql param too long')
        return `'${p.replace(/'/g, "''")}'`
      }
      if (p === null) return 'NULL'
      if (typeof p === 'object') {
        const json = JSON.stringify(p)
        if (json.length > 2000) throw new Error('neon sql param too long')
        return `'${json.replace(/'/g, "''")}'::jsonb`
      }
      throw new Error(`neon sql: unsupported param type for $${n}`)
    }
    // Function replacer: '$' sequences inside literals stay literal.
    return sql.replace(/\$(\d+)/g, (_m, n: string) => literal(params[Number(n) - 1], Number(n)))
  }
  return {
    query: async <T>(sql: string, params: unknown[] = []) => {
      const stmt = inline(sql, params)
      const isSelect = /^\s*(select|with)\b/i.test(stmt)
      const wrapped = isSelect ? `SELECT coalesce(json_agg(t),'[]') AS rows FROM (${stmt}) t` : stmt
      const args = ['psql', branch ?? 'main', '--project-id', projectId, '--', '-t', '-A', '-c', wrapped]
      const { stdout } = await sh(transcript, 'neon', args, { timeoutMs: 90_000 })
      if (!isSelect) return []
      // `neon psql` prints a status line before psql's output — rows start at the first '['.
      const jsonStart = stdout.indexOf('[')
      if (jsonStart < 0) throw new Error(`neon psql returned no rows payload: ${stdout.slice(0, 120)}`)
      return JSON.parse(stdout.slice(jsonStart)) as T[]
    },
    close: async () => {},
  }
}
