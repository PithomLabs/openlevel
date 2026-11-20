import {
  ENV_APP_MAP,
  assertEnvDatabaseIdentity,
  assertLoopbackDatabaseUrl,
  parseAppEnv,
  parseDatabaseUrl,
  resolveAppEnv,
} from './db-identity'

test.each([
  'postgres://u:p@127.0.0.1:5432/db',
  'postgres://u:p@localhost/db',
  'postgresql://u:p@[::1]:5432/db',
  'postgres:///localdb?host=/var/run/postgresql',
])('loopback target %p is accepted', (url) => {
  expect(() => assertLoopbackDatabaseUrl(url)).not.toThrow()
})

test.each([
  'postgres://u:p@neon.example.com/db?sslmode=require',
  'postgres://u:p@10.0.0.5/db',
  'postgres://u:p@db.internal/db',
  'postgres://u:p@example.com/db',
])('remote target %p is refused without echoing it', (url) => {
  let message = ''
  try {
    assertLoopbackDatabaseUrl(url)
  } catch (err) {
    message = err instanceof Error ? err.message : String(err)
  }
  expect(message).toMatch(/non-local/)
  expect(message).not.toContain('neon.example.com')
  expect(message).not.toContain('10.0.0.5')
})

test.each(['not-a-url', '', 'mysql://127.0.0.1/db', 'http://localhost/db'])(
  'malformed/non-postgres URL %p is refused',
  (url) => {
    expect(() => assertLoopbackDatabaseUrl(url)).toThrow(/refusing/)
  },
)

test('parseDatabaseUrl returns the parsed URL for valid input', () => {
  expect(parseDatabaseUrl('postgres://u@127.0.0.1:5432/db').hostname).toBe('127.0.0.1')
})

// FIND-03 matrix (§6): synthetic hosts only, never real infrastructure.
const STAGING_DB = 'postgres://u:p@staging.db.test/db'
const PROD_DB = 'postgres://u:p@prod.db.test/db'
const DEV_DB = 'postgres://u:p@dev.db.test/db'

test('development with development database: accepted', () => {
  expect(() =>
    assertEnvDatabaseIdentity({ appEnv: 'development', databaseUrl: DEV_DB, expectedDbHost: 'dev.db.test' }),
  ).not.toThrow()
})

test('staging with staging database: accepted', () => {
  expect(() =>
    assertEnvDatabaseIdentity({
      appEnv: 'staging',
      databaseUrl: STAGING_DB,
      flyAppName: 'openlevel-staging',
      expectedDbHost: 'staging.db.test',
    }),
  ).not.toThrow()
})

test('production with production database: accepted', () => {
  expect(() =>
    assertEnvDatabaseIdentity({
      appEnv: 'production',
      databaseUrl: PROD_DB,
      flyAppName: 'openlevel-prod',
      expectedDbHost: 'prod.db.test',
    }),
  ).not.toThrow()
})

test('staging with production database: refused', () => {
  expect(() =>
    assertEnvDatabaseIdentity({
      appEnv: 'staging',
      databaseUrl: PROD_DB,
      flyAppName: 'openlevel-staging',
      expectedDbHost: 'staging.db.test',
    }),
  ).toThrow(/contradicts APP_ENV=staging/)
})

test('development with production database: refused', () => {
  expect(() =>
    assertEnvDatabaseIdentity({ appEnv: 'development', databaseUrl: PROD_DB, expectedDbHost: 'dev.db.test' }),
  ).toThrow(/contradicts APP_ENV=development/)
})

test('production with staging database: refused', () => {
  expect(() =>
    assertEnvDatabaseIdentity({
      appEnv: 'production',
      databaseUrl: STAGING_DB,
      flyAppName: 'openlevel-prod',
      expectedDbHost: 'prod.db.test',
    }),
  ).toThrow(/contradicts APP_ENV=production/)
})

test('wrong Fly app identity: refused', () => {
  expect(() =>
    assertEnvDatabaseIdentity({
      appEnv: 'staging',
      databaseUrl: STAGING_DB,
      flyAppName: 'openlevel-prod',
      expectedDbHost: 'staging.db.test',
    }),
  ).toThrow(/FLY_APP_NAME .* contradicts APP_ENV=staging/)
})

test('missing required cloud identity: refused', () => {
  expect(() =>
    assertEnvDatabaseIdentity({
      appEnv: 'staging',
      databaseUrl: STAGING_DB,
      flyAppName: 'openlevel-staging',
    }),
  ).toThrow(/requires EXPECTED_DB_HOST/)
})

test('malformed database URL: refused', () => {
  expect(() =>
    assertEnvDatabaseIdentity({ appEnv: 'staging', databaseUrl: 'not a url', expectedDbHost: 'x' }),
  ).toThrow(/refusing/)
})

test('local PGlite with no cloud credentials: accepted', () => {
  expect(() => assertEnvDatabaseIdentity({ appEnv: 'development' })).not.toThrow()
})

test('loopback targets stay allowed in every environment (CI boots staging locally)', () => {
  for (const appEnv of ['development', 'staging', 'production'] as const) {
    expect(() =>
      assertEnvDatabaseIdentity({ appEnv, databaseUrl: 'postgres://u:p@127.0.0.1:5432/db' }),
    ).not.toThrow()
  }
})

test('error messages never echo the URL or credentials', () => {
  let message = ''
  try {
    assertEnvDatabaseIdentity({
      appEnv: 'staging',
      databaseUrl: 'postgres://op:SUPERSECRETPW@evil.db.test/db',
      expectedDbHost: 'staging.db.test',
    })
  } catch (err) {
    message = err instanceof Error ? err.message : ''
  }
  expect(message).toContain('contradicts')
  expect(message).not.toContain('SUPERSECRETPW')
  expect(message).not.toContain('evil.db.test')
})

test('ENV_APP_MAP pins the exact production app (G1: no substring matching)', () => {
  expect(ENV_APP_MAP).toEqual({
    development: 'openlevel-dev',
    staging: 'openlevel-staging',
    production: 'openlevel-prod',
  })
})

test('parseAppEnv matches the boot config vocabulary (N1 parity: change both together)', async () => {
  const { loadConfig } = await import('./config')
  const secrets = {
    SESSION_SECRET: 'parity-probe-session-secret-fake-00',
    CHATWOOT_WEBHOOK_SECRET: 'parity-probe-webhook-secret-fake-00',
  }
  expect(parseAppEnv(undefined)).toBe('development')
  for (const env of ['development', 'staging', 'production']) {
    expect(parseAppEnv(env)).toBe(env)
    const preview = env === 'production' ? { RESTRICTED_PREVIEW: 'false' } : {}
    expect(loadConfig({ APP_ENV: env, ...preview, ...secrets }).APP_ENV).toBe(env)
  }
  for (const bad of ['prod', 'STAGING', 'yes', '']) {
    expect(() => parseAppEnv(bad)).toThrow(/unknown APP_ENV/)
    expect(() => loadConfig({ APP_ENV: bad, ...secrets })).toThrow()
  }
})

test('R14-11: resolveAppEnv requires an explicit env for production builds and remote databases', () => {
  // Explicit values pass through (invalid ones throw via parseAppEnv).
  expect(resolveAppEnv('staging', {})).toBe('staging')
  expect(() => resolveAppEnv('prod', {})).toThrow(/unknown APP_ENV/)
  // Unset + production build refuses: name the environment.
  expect(() => resolveAppEnv(undefined, { nodeEnv: 'production' })).toThrow(/explicit/)
  // Unset + remote database refuses, even in a development build.
  expect(() => resolveAppEnv(undefined, { databaseUrl: 'postgres://u:p@staging.db.test/db' })).toThrow(/explicit/)
  expect(() => resolveAppEnv(undefined, { nodeEnv: 'production', databaseUrl: 'postgres://u:p@h/db' })).toThrow(/explicit/)
  // Unset + local-only keeps the development default.
  expect(resolveAppEnv(undefined, {})).toBe('development')
  expect(resolveAppEnv(undefined, { databaseUrl: 'postgres://u:p@127.0.0.1/db' })).toBe('development')
  expect(resolveAppEnv(undefined, { nodeEnv: 'development' })).toBe('development')
  // A malformed database URL refuses (fail closed, never echoes the URL).
  expect(() => resolveAppEnv(undefined, { databaseUrl: 'not-a-url' })).toThrow(/refusing/)
})
