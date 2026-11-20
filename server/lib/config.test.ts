import { isCloudEnv, loadConfig } from './config'

test('applies dev defaults and coerces PORT from a string', () => {
  const c = loadConfig({ PORT: '9001' })
  expect(c.PORT).toBe(9001)
  expect(c.SESSION_SECRET).toBe('dev-only-change-me')
  expect(c.CHATWOOT_WEBHOOK_SECRET).toBe('dev-secret')
  expect(c.NODE_ENV).toBe('development')
  expect(c.APP_ENV).toBe('development')
  expect(c.DATABASE_URL).toBeUndefined()
  expect(c.GATEWAY_TEXT_URL).toBeUndefined()
  expect(c.GATEWAY_PUSH_URL).toBeUndefined()
  expect(c.INTERNAL_PUSH_SECRET).toBeUndefined()
})

const STRONG = 'x'.repeat(32)

test('reads provided values over defaults', () => {
  const c = loadConfig({
    SESSION_SECRET: STRONG,
    CHATWOOT_WEBHOOK_SECRET: STRONG,
    NODE_ENV: 'production',
    APP_ENV: 'development',
    DATABASE_URL: 'postgres://x@127.0.0.1/db',
  })
  expect(c.SESSION_SECRET).toBe(STRONG)
  expect(c.NODE_ENV).toBe('production')
  expect(c.DATABASE_URL).toBe('postgres://x@127.0.0.1/db')
  expect(c.PORT).toBe(8790)
})

test('R14-11: APP_ENV must be explicit for production builds and remote databases (no silent default)', () => {
  // A production build that does not name its environment refuses to boot —
  // silently defaulting to development while NODE_ENV=production is exactly
  // the misconfiguration that deactivates safety controls.
  expect(() =>
    loadConfig({ NODE_ENV: 'production', SESSION_SECRET: STRONG, CHATWOOT_WEBHOOK_SECRET: STRONG }),
  ).toThrow(/APP_ENV.*explicit/i)
  // A remote database without a named environment refuses too, even in a
  // development build: the env name must be chosen, never defaulted, when a
  // shared database is at stake.
  expect(() =>
    loadConfig({ DATABASE_URL: 'postgres://u:p@staging.db.test/db', EXPECTED_DB_HOST: 'staging.db.test' }),
  ).toThrow(/APP_ENV.*explicit/i)
  // Local development keeps its default: loopback-only, nothing shared.
  expect(loadConfig({}).APP_ENV).toBe('development')
  expect(loadConfig({ DATABASE_URL: 'postgres://x@127.0.0.1/db' }).APP_ENV).toBe('development')
})

test('R14-11: production must explicitly choose preview or live (unset flag refuses boot)', () => {
  const base = { APP_ENV: 'production', SESSION_SECRET: STRONG, CHATWOOT_WEBHOOK_SECRET: STRONG }
  expect(() => loadConfig(base)).toThrow(/RESTRICTED_PREVIEW/)
  expect(() => loadConfig({ ...base, RESTRICTED_PREVIEW: 'yes' })).toThrow(/RESTRICTED_PREVIEW/)
  expect(loadConfig({ ...base, RESTRICTED_PREVIEW: 'true' }).RESTRICTED_PREVIEW).toBe('true')
  expect(loadConfig({ ...base, RESTRICTED_PREVIEW: 'false' }).RESTRICTED_PREVIEW).toBe('false')
  // The preview flag outside production is a contradiction, not a no-op.
  expect(() => loadConfig({ APP_ENV: 'staging', RESTRICTED_PREVIEW: 'true', SESSION_SECRET: STRONG, CHATWOOT_WEBHOOK_SECRET: STRONG })).toThrow(
    /RESTRICTED_PREVIEW/,
  )
})

test('rejects the dev-default SESSION_SECRET in production', () => {
  expect(() =>
    loadConfig({ NODE_ENV: 'production', APP_ENV: 'production', RESTRICTED_PREVIEW: 'false', SESSION_SECRET: 'dev-only-change-me', CHATWOOT_WEBHOOK_SECRET: STRONG }),
  ).toThrow(/SESSION_SECRET/)
})

test('rejects the dev-default CHATWOOT_WEBHOOK_SECRET in production', () => {
  expect(() =>
    loadConfig({ NODE_ENV: 'production', APP_ENV: 'production', RESTRICTED_PREVIEW: 'false', SESSION_SECRET: STRONG, CHATWOOT_WEBHOOK_SECRET: 'dev-secret' }),
  ).toThrow(/CHATWOOT_WEBHOOK_SECRET/)
})

test('rejects a too-short secret in production', () => {
  expect(() =>
    loadConfig({ NODE_ENV: 'production', APP_ENV: 'production', RESTRICTED_PREVIEW: 'false', SESSION_SECRET: 'short', CHATWOOT_WEBHOOK_SECRET: STRONG }),
  ).toThrow(/32 characters/)
})

test('allows a short non-default secret outside production', () => {
  const c = loadConfig({ NODE_ENV: 'development', SESSION_SECRET: 'short-dev' })
  expect(c.SESSION_SECRET).toBe('short-dev')
})

test('FEDERATION_SERVICE_TOKEN is undefined when unset (federation stays inert)', () => {
  const cfg = loadConfig({ NODE_ENV: 'development' })
  expect(cfg.FEDERATION_SERVICE_TOKEN).toBeUndefined()
})

test('FEDERATION_SERVICE_TOKEN passes through when set', () => {
  const cfg = loadConfig({ NODE_ENV: 'development', FEDERATION_SERVICE_TOKEN: 'tok-123' })
  expect(cfg.FEDERATION_SERVICE_TOKEN).toBe('tok-123')
})

test('a too-short FEDERATION_SERVICE_TOKEN is rejected in production', () => {
  expect(() =>
    loadConfig({
      NODE_ENV: 'production',
      APP_ENV: 'production',
      RESTRICTED_PREVIEW: 'false',
      SESSION_SECRET: 'x'.repeat(32),
      CHATWOOT_WEBHOOK_SECRET: 'y'.repeat(32),
      FEDERATION_SERVICE_TOKEN: 'short',
    }),
  ).toThrow(/FEDERATION_SERVICE_TOKEN/)
})

test('APP_ENV=staging enforces strict secrets even with NODE_ENV unset', () => {
  expect(() =>
    loadConfig({ APP_ENV: 'staging', SESSION_SECRET: 'dev-only-change-me', CHATWOOT_WEBHOOK_SECRET: 'z'.repeat(32) }),
  ).toThrow(/SESSION_SECRET/)
  const c = loadConfig({
    APP_ENV: 'staging',
    NODE_ENV: 'production',
    SESSION_SECRET: 'x'.repeat(32),
    CHATWOOT_WEBHOOK_SECRET: 'y'.repeat(32),
  })
  expect(c.APP_ENV).toBe('staging')
})

test('an unknown APP_ENV is rejected (fail closed)', () => {
  expect(() => loadConfig({ APP_ENV: 'prod' })).toThrow()
})

test('a too-short INTERNAL_PUSH_SECRET is rejected outside development', () => {
  expect(() =>
    loadConfig({
      APP_ENV: 'production',
      RESTRICTED_PREVIEW: 'false',
      SESSION_SECRET: 'x'.repeat(32),
      CHATWOOT_WEBHOOK_SECRET: 'y'.repeat(32),
      INTERNAL_PUSH_SECRET: 'short',
    }),
  ).toThrow(/INTERNAL_PUSH_SECRET/)
  // Unset stays unset: the rail reports "not set up", never a fake value.
  const c = loadConfig({ APP_ENV: 'production', RESTRICTED_PREVIEW: 'false', SESSION_SECRET: 'x'.repeat(32), CHATWOOT_WEBHOOK_SECRET: 'y'.repeat(32) })
  expect(c.INTERNAL_PUSH_SECRET).toBeUndefined()
})

test('loadConfig refuses a staging process pointed at another env database (FIND-03)', () => {
  expect(() =>
    loadConfig({
      APP_ENV: 'staging',
      NODE_ENV: 'production',
      SESSION_SECRET: STRONG,
      CHATWOOT_WEBHOOK_SECRET: STRONG,
      DATABASE_URL: 'postgres://u:p@prod.db.test/db',
      FLY_APP_NAME: 'openlevel-staging',
      EXPECTED_DB_HOST: 'staging.db.test',
    }),
  ).toThrow(/contradicts APP_ENV=staging/)
})

test('loadConfig refuses a cloud boot whose Fly app contradicts APP_ENV (FIND-03)', () => {
  expect(() =>
    loadConfig({
      APP_ENV: 'staging',
      NODE_ENV: 'production',
      SESSION_SECRET: STRONG,
      CHATWOOT_WEBHOOK_SECRET: STRONG,
      DATABASE_URL: 'postgres://u:p@staging.db.test/db',
      FLY_APP_NAME: 'openlevel-prod',
      EXPECTED_DB_HOST: 'staging.db.test',
    }),
  ).toThrow(/FLY_APP_NAME .* contradicts/)
})

test('loadConfig accepts a coherent cloud identity (FIND-03)', () => {
  const c = loadConfig({
    APP_ENV: 'staging',
    NODE_ENV: 'production',
    SESSION_SECRET: STRONG,
    CHATWOOT_WEBHOOK_SECRET: STRONG,
    DATABASE_URL: 'postgres://u:p@staging.db.test/db',
    FLY_APP_NAME: 'openlevel-staging',
    EXPECTED_DB_HOST: 'staging.db.test',
  })
  expect(c.APP_ENV).toBe('staging')
  expect(c.EXPECTED_DB_HOST).toBe('staging.db.test')
})

test('isCloudEnv treats staging/production (or NODE_ENV=production) as cloud', () => {
  expect(isCloudEnv({ APP_ENV: 'development', NODE_ENV: 'development' })).toBe(false)
  expect(isCloudEnv({ APP_ENV: 'staging', NODE_ENV: 'development' })).toBe(true)
  expect(isCloudEnv({ APP_ENV: 'production', NODE_ENV: 'production' })).toBe(true)
  // Backstop: a production build with APP_ENV misconfigured stays strict.
  expect(isCloudEnv({ APP_ENV: 'development', NODE_ENV: 'production' })).toBe(true)
})

test('G1: workflow waits default OFF and enable only on exact true', () => {
  expect(loadConfig({}).WORKFLOW_WAITS_ENABLED).toBe('false')
  expect(loadConfig({ WORKFLOW_WAITS_ENABLED: 'true' }).WORKFLOW_WAITS_ENABLED).toBe('true')
  expect(loadConfig({ WORKFLOW_WAITS_ENABLED: 'false' }).WORKFLOW_WAITS_ENABLED).toBe('false')
  for (const bad of ['yes', '1', 'TRUE', 'enabled']) {
    expect(() => loadConfig({ WORKFLOW_WAITS_ENABLED: bad })).toThrow()
  }
})
