/**
 * Black-box refusal tests for the deploy guards (scripts/toolchain.mjs
 * fly-guard / release-guard / env validate). Spawns the real script so the
 * tests prove the shipped behavior, not a reimplementation. Every refusal
 * condition, plus path handling, malformed configs, and unexpected names.
 */
import { spawnSync } from 'node:child_process'
import { symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ENV_APP_MAP as SERVER_ENV_APP_MAP } from '../server/lib/db-identity'
import {
  ENV_APP_MAP as GUARD_ENV_APP_MAP,
  isValidAppName,
  parseDeployedDigest,
  parseFlyConfig,
} from './toolchain.mjs'

function run(sub: string, env: Record<string, string>): { status: number; out: string } {
  const res = spawnSync(process.execPath, ['scripts/toolchain.mjs', sub], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
  })
  return { status: res.status ?? 1, out: `${res.stdout ?? ''}\n${res.stderr ?? ''}` }
}

function fly(env: Record<string, string>) {
  return run('fly-guard', env)
}

// Temp product-shaped config inside the repo (cleaned after each test).
let owned: string[] = []
function repoConfig(name: string, body: string): string {
  writeFileSync(name, body)
  owned.push(name)
  return name
}
afterEach(() => {
  for (const f of owned) {
    try {
      unlinkSync(f)
    } catch {
      /* already gone */
    }
  }
  owned = []
})

// Fixture region code: the guard checks presence (owner-confirmed at
// provisioning), never validity — validity is the owner's geography call.
const STAGING_LIKE = (app: string) =>
  `app = "${app}"\nprimary_region = "iad"\n[env]\n  APP_ENV = "staging"\n`

function passConfig(app = 'openlevel-staging'): string {
  return repoConfig(`fly.guard-pass-${process.pid}-${Math.random().toString(36).slice(2)}.toml`, STAGING_LIKE(app))
}

test('fly-guard passes a complete config with explicit app + confirm', () => {
  const r = fly({ FLY_APP: 'openlevel-staging', FLY_CONFIG: passConfig(), CONFIRM_DEPLOY: 'yes' })
  expect(r.status).toBe(0)
  expect(r.out).toMatch(/guard passed/)
})

test('fly-guard refuses the real staging config until the owner confirms a region (F3)', () => {
  const r = fly({ FLY_APP: 'openlevel-staging', FLY_CONFIG: 'fly.toml', CONFIRM_DEPLOY: 'yes' })
  expect(r.status).not.toBe(0)
  expect(r.out).toMatch(/sets no primary_region/)
})

test('(1) refuses a missing FLY_APP', () => {
  const r = fly({ FLY_CONFIG: 'fly.toml', CONFIRM_DEPLOY: 'yes' })
  expect(r.status).not.toBe(0)
  expect(r.out).toMatch(/FLY_APP is required/)
})

test('(2) refuses a missing FLY_CONFIG', () => {
  const r = fly({ FLY_APP: 'openlevel-staging', CONFIRM_DEPLOY: 'yes' })
  expect(r.status).not.toBe(0)
  expect(r.out).toMatch(/FLY_CONFIG is required/)
})

test('(3) refuses a nonexistent config', () => {
  const r = fly({ FLY_APP: 'openlevel-staging', FLY_CONFIG: 'fly.nope.toml', CONFIRM_DEPLOY: 'yes' })
  expect(r.status).not.toBe(0)
  expect(r.out).toMatch(/does not exist/)
})

test('(3) refuses an absolute config path outside the repo', () => {
  const outside = join(tmpdir(), `guard-outside-${process.pid}.toml`)
  writeFileSync(outside, STAGING_LIKE('openlevel-staging'))
  try {
    const r = fly({ FLY_APP: 'openlevel-staging', FLY_CONFIG: outside, CONFIRM_DEPLOY: 'yes' })
    expect(r.status).not.toBe(0)
    expect(r.out).toMatch(/must live inside the repo/)
  } finally {
    unlinkSync(outside)
  }
})

test('(3) refuses a symlink escape (in-repo link to an outside file)', () => {
  const outside = join(tmpdir(), `guard-target-${process.pid}.toml`)
  writeFileSync(outside, STAGING_LIKE('openlevel-staging'))
  const link = `fly.guard-link-${process.pid}.toml`
  symlinkSync(outside, link)
  owned.push(link)
  try {
    const r = fly({ FLY_APP: 'openlevel-staging', FLY_CONFIG: link, CONFIRM_DEPLOY: 'yes' })
    expect(r.status).not.toBe(0)
    expect(r.out).toMatch(/must live inside the repo/)
  } finally {
    unlinkSync(outside)
  }
})

test('(3) refuses a parent-directory escape (../outside)', () => {
  const r = fly({ FLY_APP: 'openlevel-staging', FLY_CONFIG: '../outside.toml', CONFIRM_DEPLOY: 'yes' })
  expect(r.status).not.toBe(0)
  expect(r.out).toMatch(/does not exist|must live inside the repo/)
})

test('(4) refuses the canonical P2 proof config', () => {
  const r = fly({
    FLY_APP: 'openlevel-p2-staging',
    FLY_CONFIG: 'phase0/p2/fly.staging.toml',
    CONFIRM_DEPLOY: 'yes',
  })
  expect(r.status).not.toBe(0)
  expect(r.out).toMatch(/isolated P2 proof/)
})

test('(4) refuses a renamed copy declaring the P2 app (content belt)', () => {
  const name = repoConfig(`fly.guard-p2copy-${process.pid}.toml`, STAGING_LIKE('openlevel-p2-staging'))
  const r = fly({ FLY_APP: 'openlevel-p2-staging', FLY_CONFIG: name, CONFIRM_DEPLOY: 'yes' })
  expect(r.status).not.toBe(0)
  expect(r.out).toMatch(/P2 staging app/)
})

test('(5) refuses when the declared app does not match FLY_APP', () => {
  const r = fly({ FLY_APP: 'openlevel-dev', FLY_CONFIG: 'fly.toml', CONFIRM_DEPLOY: 'yes' })
  expect(r.status).not.toBe(0)
  expect(r.out).toMatch(/declares app "openlevel-staging" but FLY_APP is "openlevel-dev"/)
})

test('(5) refuses an unexpected application name paired with a real config', () => {
  const r = fly({ FLY_APP: 'openlevel-evil', FLY_CONFIG: 'fly.toml', CONFIRM_DEPLOY: 'yes' })
  expect(r.status).not.toBe(0)
  expect(r.out).toMatch(/but FLY_APP is "openlevel-evil"/)
})

test('(5) refuses a malformed config declaring no app', () => {
  const name = repoConfig(`fly.guard-noapp-${process.pid}.toml`, '[env]\n  APP_ENV = "staging"\n')
  const r = fly({ FLY_APP: 'openlevel-staging', FLY_CONFIG: name, CONFIRM_DEPLOY: 'yes' })
  expect(r.status).not.toBe(0)
  expect(r.out).toMatch(/declares no app name/)
})

test('(6) refuses without CONFIRM_DEPLOY=yes (missing and wrong values)', () => {
  const cfg = passConfig()
  const missing = fly({ FLY_APP: 'openlevel-staging', FLY_CONFIG: cfg })
  expect(missing.status).not.toBe(0)
  expect(missing.out).toMatch(/CONFIRM_DEPLOY=yes/)
  const wrong = fly({ FLY_APP: 'openlevel-staging', FLY_CONFIG: cfg, CONFIRM_DEPLOY: 'true' })
  expect(wrong.status).not.toBe(0)
  expect(wrong.out).toMatch(/CONFIRM_DEPLOY=yes/)
})

test('fly-guard demands production double confirmation on the generic path (F2)', () => {
  const cfg = repoConfig(
    `fly.guard-prod-${process.pid}.toml`,
    'app = "openlevel-prod"\nprimary_region = "iad"\n[env]\n  APP_ENV = "production"\n',
  )
  const single = fly({ FLY_APP: 'openlevel-prod', FLY_CONFIG: cfg, CONFIRM_DEPLOY: 'yes' })
  expect(single.status).not.toBe(0)
  expect(single.out).toMatch(/CONFIRM_PRODUCTION=yes/)
  const dbl = fly({
    FLY_APP: 'openlevel-prod',
    FLY_CONFIG: cfg,
    CONFIRM_DEPLOY: 'yes',
    CONFIRM_PRODUCTION: 'yes',
  })
  expect(dbl.status).toBe(0)
  expect(dbl.out).toMatch(/guard passed/)
})

test('fly-guard refuses malformed TOML, dup keys, and DNS-unsafe names (parser)', () => {
  const bad = repoConfig(`fly.guard-bad-${process.pid}.toml`, 'app = "oops"\n[env\n')
  expect(fly({ FLY_APP: 'oops', FLY_CONFIG: bad, CONFIRM_DEPLOY: 'yes' }).out).toMatch(/not valid TOML/)
  const dup = repoConfig(`fly.guard-dup-${process.pid}.toml`, 'app = "a"\napp = "b"\n')
  expect(fly({ FLY_APP: 'a', FLY_CONFIG: dup, CONFIRM_DEPLOY: 'yes' }).out).toMatch(/not valid TOML/)
  const evil = fly({ FLY_APP: 'x; rm -rf /', FLY_CONFIG: passConfig(), CONFIRM_DEPLOY: 'yes' })
  expect(evil.status).not.toBe(0)
  expect(evil.out).toMatch(/not a valid app name/)
})

test('parser reads single-quoted apps and ignores [env]-nested app keys', () => {
  expect(parseFlyConfig("app = 'openlevel-staging'\n", 't').app).toBe('openlevel-staging')
  expect(() => parseFlyConfig('[env]\napp = "openlevel-staging"\n', 't')).toThrow(/declares no app name/)
  expect(isValidAppName('openlevel-staging')).toBe(true)
  expect(isValidAppName('UPPER')).toBe(false)
  expect(isValidAppName('has space')).toBe(false)
})

test('guard env→app map matches the canonical server map (G1)', () => {
  expect(GUARD_ENV_APP_MAP).toEqual(SERVER_ENV_APP_MAP)
  expect(GUARD_ENV_APP_MAP.production).toBe('openlevel-prod')
})

test('(7) bare invocation refuses: nothing is inferred', () => {
  const r = fly({})
  expect(r.status).not.toBe(0)
  expect(r.out).toMatch(/FLY_APP is required/)
})

test('release-guard passes an explicit staging rollback', () => {
  const r = run('release-guard', {
    FLY_APP: 'openlevel-staging',
    FLY_CONFIG: 'fly.toml',
    RELEASE_IMAGE: 'registry.fly.io/openlevel-staging@sha256:abababababababababababababababababababababababababababababababab',
    CONFIRM_DEPLOY: 'yes',
  })
  expect(r.status).toBe(0)
  expect(r.out).toMatch(/rollback guard passed/)
})

test('release-guard refuses missing app, config, image, and confirm', () => {
  expect(run('release-guard', { RELEASE_IMAGE: 'img:1', CONFIRM_DEPLOY: 'yes' }).status).not.toBe(0)
  expect(
    run('release-guard', { FLY_APP: 'openlevel-staging', RELEASE_IMAGE: 'img:1', CONFIRM_DEPLOY: 'yes' }).out,
  ).toMatch(/FLY_CONFIG is required/)
  expect(
    run('release-guard', { FLY_APP: 'openlevel-staging', FLY_CONFIG: 'fly.toml', CONFIRM_DEPLOY: 'yes' }).out,
  ).toMatch(/RELEASE_IMAGE is required/)
  expect(
    run('release-guard', {
      FLY_APP: 'openlevel-staging',
      FLY_CONFIG: 'fly.toml',
      RELEASE_IMAGE: `registry.fly.io/openlevel-staging@sha256:${'ab'.repeat(32)}`,
    }).out,
  ).toMatch(/CONFIRM_DEPLOY=yes/)
})

test('release-guard refuses app↔config mismatch for every environment (FIND-04)', () => {
  const pairs: [string, string][] = [
    ['openlevel-dev', 'fly.toml'],
    ['openlevel-staging', 'fly.dev.toml'],
    ['openlevel-prod', 'fly.toml'],
    ['openlevel-staging', 'fly.prod.toml'],
  ]
  for (const [app, config] of pairs) {
    const r = run('release-guard', {
      FLY_APP: app,
      FLY_CONFIG: config,
      RELEASE_IMAGE: 'registry.fly.io/x@sha256:abababababababababababababababababababababababababababababababab',
      CONFIRM_DEPLOY: 'yes',
    })
    expect(r.status, `${app} + ${config}`).not.toBe(0)
    expect(r.out).toMatch(/declares app/)
  }
})

test('release-guard refuses anything but digest-pinned refs (FIND-10)', () => {
  const base = { FLY_APP: 'openlevel-staging', FLY_CONFIG: 'fly.toml', CONFIRM_DEPLOY: 'yes' }
  for (const image of [
    'justaname',
    'registry.fly.io/openlevel-staging:latest',
    'registry.fly.io/openlevel-staging:v123',
    'registry.fly.io/openlevel-staging@sha256:xyz',
    'registry.fly.io/openlevel-staging@sha256:ab',
  ]) {
    const r = run('release-guard', { ...base, RELEASE_IMAGE: image })
    expect(r.status, image).not.toBe(0)
    expect(r.out).toMatch(/digest-pinned image ref/)
  }
})

test('release-guard demands double confirmation for production', () => {
  const single = run('release-guard', {
    FLY_APP: 'openlevel-prod',
    FLY_CONFIG: 'fly.prod.toml',
    RELEASE_IMAGE: 'registry.fly.io/openlevel-prod@sha256:abababababababababababababababababababababababababababababababab',
    CONFIRM_DEPLOY: 'yes',
  })
  expect(single.status).not.toBe(0)
  expect(single.out).toMatch(/CONFIRM_PRODUCTION=yes/)
  const dbl = run('release-guard', {
    FLY_APP: 'openlevel-prod',
    FLY_CONFIG: 'fly.prod.toml',
    RELEASE_IMAGE: 'registry.fly.io/openlevel-prod@sha256:abababababababababababababababababababababababababababababababab',
    CONFIRM_DEPLOY: 'yes',
    CONFIRM_PRODUCTION: 'yes',
  })
  expect(dbl.status).toBe(0)
})

test('production status is exact-mapped, never substring-matched (G1)', () => {
  const cfg = repoConfig(
    `fly.guard-notprod-${process.pid}.toml`,
    'app = "myprod-app"\nprimary_region = "iad"\n',
  )
  const r = run('release-guard', {
    FLY_APP: 'myprod-app',
    FLY_CONFIG: cfg,
    RELEASE_IMAGE: 'registry.fly.io/myprod-app@sha256:abababababababababababababababababababababababababababababababab',
    CONFIRM_DEPLOY: 'yes',
  })
  // Not the mapped production app: single confirmation suffices. If this
  // name ever becomes production, the owner adds it to the mapping.
  expect(r.status).toBe(0)
})

test('env validate passes on this coherent checkout', () => {
  const r = run('env', {})
  expect(r.status).not.toBe(0) // bare `env` names no view
  const v = spawnSync(process.execPath, ['scripts/toolchain.mjs', 'env', 'validate'], { encoding: 'utf8' })
  expect(v.status).toBe(0)
  expect(v.stdout ?? '').toMatch(/env validate: OK/)
})

test('env status is read-only and prints no secret values', () => {
  const v = spawnSync(process.execPath, ['scripts/toolchain.mjs', 'env', 'status'], { encoding: 'utf8' })
  expect(v.status).toBe(0)
  expect(v.stdout ?? '').toMatch(/openlevel-staging/)
  expect(v.stdout ?? '').not.toMatch(/postgres:\/\/|BEGIN .*PRIVATE|sk-ant-|glpat-/i)
})

const DIGEST = `ghcr.io/owner/openlevel@sha256:${'ab'.repeat(32)}`

test('fly-guard validates IMAGE_DIGEST when set, ignores when absent (FIND-10)', () => {
  const cfg = passConfig()
  const base = { FLY_APP: 'openlevel-staging', FLY_CONFIG: cfg, CONFIRM_DEPLOY: 'yes' }
  expect(fly({ ...base, IMAGE_DIGEST: DIGEST }).status).toBe(0)
  const tagged = fly({ ...base, IMAGE_DIGEST: 'ghcr.io/owner/openlevel:abc123' })
  expect(tagged.status).not.toBe(0)
  expect(tagged.out).toMatch(/digest-pinned image ref/)
  const short = fly({ ...base, IMAGE_DIGEST: 'ghcr.io/owner/openlevel@sha256:ab' })
  expect(short.status).not.toBe(0)
  expect(short.out).toMatch(/digest-pinned image ref/)
})

test('parseDeployedDigest accepts digest refs at known locations (FIND-10)', () => {
  expect(parseDeployedDigest(JSON.stringify({ Digest: DIGEST }), 'a')).toBe(DIGEST)
  expect(parseDeployedDigest(JSON.stringify({ digest: DIGEST }), 'a')).toBe(DIGEST)
  expect(parseDeployedDigest(JSON.stringify({ Image: DIGEST }), 'a')).toBe(DIGEST)
  expect(parseDeployedDigest(JSON.stringify({ image: { Digest: DIGEST } }), 'a')).toBe(DIGEST)
})

test('parseDeployedDigest fails closed on anything unrecognized (FIND-10)', () => {
  for (const stdout of [
    'not json at all',
    JSON.stringify({ Digest: 'ghcr.io/owner/openlevel:latest' }),
    JSON.stringify({ something: 'else' }),
    JSON.stringify({ Digest: 'sha256:xyz' }),
    '',
  ]) {
    expect(() => parseDeployedDigest(stdout, 'myapp')).toThrow(/refusing/)
  }
})
