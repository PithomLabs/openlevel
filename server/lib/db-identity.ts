/**
 * Database-target identity checks (Review 11 FIND-03/FIND-05 family).
 *
 * Local one-off scripts (`db/seed.ts`, `db/migrate.ts`) must refuse remote
 * targets even when invoked directly, bypassing the Taskfile guard. Stage 3
 * extends this module with the full APP_ENV/app/database cross-check; the
 * loopback rule here is its local-only foundation.
 */

/** Parse a DATABASE_URL or throw a fail-closed error (never echoes the URL). */
export function parseDatabaseUrl(url: string): URL {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
      throw new Error(`refusing database URL with scheme ${JSON.stringify(parsed.protocol)}`)
    }
    return parsed
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('refusing database URL')) throw err
    throw new Error('refusing malformed DATABASE_URL')
  }
}

/**
 * Require a local-only target. Allows loopback TCP (127.0.0.1, localhost,
 * ::1) and unix-socket URLs (empty hostname is inherently local). Anything
 * else — including Neon hostnames — throws without echoing the URL.
 */
export function assertLoopbackDatabaseUrl(url: string): void {
  if (isLocalDatabaseHost(parseDatabaseUrl(url).hostname)) return
  throw new Error('refusing to touch a non-local database (local loopback or socket only)')
}

/** Loopback TCP names plus the empty hostname (unix socket: inherently local). */
export function isLocalDatabaseHost(hostname: string): boolean {
  // URL.hostname keeps IPv6 brackets ([::1]); strip them before comparing.
  const host = hostname.replace(/^\[|\]$/g, '')
  return host === '' || host === '127.0.0.1' || host === 'localhost' || host === '::1'
}

/**
 * Exact environment-to-application mapping (Review 11 G1: production status
 * derives from this table, never from substring-matching an app name).
 */
export const ENV_APP_MAP: Record<'development' | 'staging' | 'production', string> = {
  development: 'openlevel-dev',
  staging: 'openlevel-staging',
  production: 'openlevel-prod',
}

/**
 * Parse APP_ENV the same way the boot path does (default + closed value
 * set). Exported so release tooling enforces the identical environment
 * vocabulary without depending on the whole app config (whose secret
 * posture a migration runner must not require). PARITY: the accepted
 * values must match Config['APP_ENV'] in config.ts (pinned by test —
 * change both together).
 */
export function parseAppEnv(raw: string | undefined): keyof typeof ENV_APP_MAP {
  const value = raw ?? 'development'
  if (value !== 'development' && value !== 'staging' && value !== 'production') {
    throw new Error(`unknown APP_ENV ${JSON.stringify(raw)}: expected development, staging, or production`)
  }
  return value
}

/**
 * Resolve APP_ENV with the no-silent-default rule (R14-11, §6 req 1-2):
 * an explicitly set value parses via parseAppEnv (invalid throws), but an
 * UNSET value defaults to development ONLY for local-only execution. A
 * production build or a non-loopback database without a named environment
 * refuses — the environment must be chosen, never defaulted, when shared
 * infrastructure or safety controls are at stake. Shared by the boot path
 * (loadConfig) and the release path (migrate-release, N1 identity-only).
 */
export function resolveAppEnv(
  raw: string | undefined,
  opts: { nodeEnv?: string; databaseUrl?: string },
): keyof typeof ENV_APP_MAP {
  if (raw !== undefined) return parseAppEnv(raw)
  if (opts.nodeEnv === 'production') {
    throw new Error('APP_ENV must be set explicitly for a production build (refusing to default it)')
  }
  if (opts.databaseUrl !== undefined && opts.databaseUrl !== '') {
    const host = parseDatabaseUrl(opts.databaseUrl).hostname
    if (!isLocalDatabaseHost(host)) {
      throw new Error('APP_ENV must be set explicitly when the database is not local (refusing to default it)')
    }
  }
  return 'development'
}

export interface EnvDatabaseIdentity {
  appEnv: keyof typeof ENV_APP_MAP
  databaseUrl?: string
  /** Fly runtime identity (FLY_APP_NAME). Absent off-platform; always set on Fly. */
  flyAppName?: string
  /** Owner-configured exact DB hostname for this environment (non-secret). */
  expectedDbHost?: string
}

/**
 * Fail-closed environment/database contradiction check (FIND-03). Rules:
 *
 * R1 — Platform identity: when FLY_APP_NAME is present (i.e. running on
 * Fly), it must exactly equal the mapped app for APP_ENV. Absent locally,
 * the rule is skipped — but nothing on Fly can dodge it.
 *
 * R2 — Database identity: a non-loopback DATABASE_URL requires
 * EXPECTED_DB_HOST to be set and exactly equal to the URL's hostname.
 * Malformed URLs refuse. Loopback/socket targets are always allowed (they
 * are definitionally disposable-local; CI boots staging against localhost).
 * No DATABASE_URL is allowed here (PGlite/dev-server path); bootstrap
 * asserts its own requirement separately.
 *
 * R3 follows from R1+R2: a cloud process cannot quietly boot against
 * another environment's database — cross-env URLs mismatch EXPECTED_DB_HOST
 * and there is no silent fallback. Error messages name the rule and the
 * expected identity, never the URL or credentials.
 */
export function assertEnvDatabaseIdentity(input: EnvDatabaseIdentity): void {
  const expectedApp = ENV_APP_MAP[input.appEnv]
  if (expectedApp === undefined) {
    throw new Error(`refusing to boot with unknown APP_ENV ${JSON.stringify(input.appEnv)}`)
  }
  if (input.flyAppName !== undefined && input.flyAppName !== '' && input.flyAppName !== expectedApp) {
    throw new Error(
      `refusing to boot: FLY_APP_NAME ${JSON.stringify(input.flyAppName)} contradicts APP_ENV=${input.appEnv} (expected app ${expectedApp})`,
    )
  }
  if (input.databaseUrl === undefined || input.databaseUrl === '') return
  const host = parseDatabaseUrl(input.databaseUrl).hostname
  if (isLocalDatabaseHost(host)) return
  if (input.expectedDbHost === undefined || input.expectedDbHost === '') {
    throw new Error(
      `refusing to boot: non-local DATABASE_URL with APP_ENV=${input.appEnv} requires EXPECTED_DB_HOST (outstanding owner input)`,
    )
  }
  if (host.replace(/^\[|\]$/g, '') !== input.expectedDbHost) {
    throw new Error(
      `refusing to boot: DATABASE_URL target contradicts APP_ENV=${input.appEnv} (expected host ${input.expectedDbHost})`,
    )
  }
}
