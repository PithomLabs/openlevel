/**
 * Static contracts for Taskfile.yml (Prompt 31: P1-1 wiring, P2-3 quoting).
 * Text assertions in the packaging.test.ts style — no task binary needed.
 * Externally supplied values must only ever enter `env:` mappings (data);
 * shell source must never contain rendered `{{.VAR}}` templates.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

const taskfile = readFileSync('Taskfile.yml', 'utf8')

/** Split the Taskfile into per-task blocks keyed by task name. */
function taskBlocks(): Map<string, string> {
  const blocks = new Map<string, string>()
  let current: string | null = null
  let buf: string[] = []
  for (const line of taskfile.split('\n')) {
    const m = /^  ([\w:.-]+):$/.exec(line)
    if (m) {
      if (current) blocks.set(current, buf.join('\n'))
      current = m[1]
      buf = [line]
    } else if (current) {
      buf.push(line)
    }
  }
  if (current) blocks.set(current, buf.join('\n'))
  return blocks
}

const blocks = taskBlocks()

describe('template interpolation confinement (P2-3)', () => {
  test('every {{.VAR}} template lives on an env-mapping line, never in shell source', () => {
    const violations = taskfile
      .split('\n')
      .filter((line) => line.includes('{{.'))
      .filter((line) => !/^\s+[A-Z_][A-Z0-9_]*:\s*"\{\{\./.test(line))
    expect(violations).toEqual([])
  })

  test('no task-level vars shadow CLI-provided globals', () => {
    for (const [name, body] of blocks) {
      expect(body, `task ${name} must not define vars:`).not.toMatch(/^\s+vars:\s*$/m)
    }
  })

  test('no dotenv stanza: the Taskfile never loads .env', () => {
    expect(taskfile).not.toMatch(/^\s*dotenv\s*:/m)
  })
})

describe('fly argument safety (P2-3)', () => {
  const flyCmds = ['fly:status', 'fly:logs', 'fly:releases', 'fly:open']

  test.each(flyCmds)('%s passes the app name as one quoted expansion', (task) => {
    const body = blocks.get(task) ?? ''
    expect(body).toContain('-a "$FLY_APP"')
    for (const line of body.split('\n')) {
      for (let i = line.indexOf('$FLY_APP'); i !== -1; i = line.indexOf('$FLY_APP', i + 1)) {
        expect(line[i - 1], `unquoted $FLY_APP in ${task}: ${line}`).toBe('"')
      }
    }
  })

  test('fly:deploy quotes both app and config as single arguments', () => {
    const body = blocks.get('fly:deploy') ?? ''
    // Raw YAML text: double-quoted string, so quotes appear backslash-escaped.
    expect(body).toContain('fly deploy -a \\"$FLY_APP\\" -c \\"$FLY_CONFIG\\"')
  })

  test.each(['-a "$FLY_APP"', '-c "$FLY_CONFIG"'])('quoted expansion %p survives hostile values as one argv', (shape) => {
    void shape
    const sentinel = join(tmpdir(), `openlevel-argprobe-${process.pid}`)
    const hostile = ['ordinary-app', 'app with spaces', 'a"b', "a'b", '$(touch ' + sentinel + ')', 'a;b', '', '*', 'a`id`b']
    for (const value of hostile) {
      const out = execFileSync('sh', ['-c', 'printf "<%s>\\n" "$PROBE"', 'sh'], {
        env: { ...process.env, PROBE: value },
        encoding: 'utf8',
      })
      expect(out, `value ${JSON.stringify(value)} must arrive as one argv`).toBe(`<${value}>\n`)
    }
    expect(existsSync(sentinel)).toBe(false)
    if (existsSync(sentinel)) unlinkSync(sentinel)
  })
})

describe('deploy task safety (explicit env selection, no inference)', () => {
  test.each([
    ['deploy:dev', 'openlevel-dev', 'fly.dev.toml'],
    ['deploy:staging', 'openlevel-staging', 'fly.toml'],
    ['deploy:production', 'openlevel-prod', 'fly.prod.toml'],
  ])('%s pins its app + config literally (no CLI-provided target)', (task, app, config) => {
    const body = blocks.get(task) ?? ''
    expect(body).toContain(`FLY_APP: "${app}"`)
    expect(body).toContain(`FLY_CONFIG: "${config}"`)
    expect(body).not.toContain('FLY_APP: "{{.FLY_APP}}"')
    expect(body).not.toContain('FLY_CONFIG: "{{.FLY_CONFIG}}"')
    expect(body).toContain('fly-guard')
  })

  test.each(['deploy:dev', 'deploy:staging', 'deploy:production'])('%s refuses without CONFIRM_DEPLOY=yes', (task) => {
    const body = blocks.get(task) ?? ''
    expect(body).toMatch(/test "\$CONFIRM_DEPLOY" = "yes"/)
  })

  test('deploy:production needs a second production confirmation', () => {
    const body = blocks.get('deploy:production') ?? ''
    expect(body).toMatch(/test "\$CONFIRM_PRODUCTION" = "yes"/)
  })

  test('deploy:dev and deploy:staging never mention production confirmation', () => {
    expect(blocks.get('deploy:dev') ?? '').not.toContain('CONFIRM_PRODUCTION')
    expect(blocks.get('deploy:staging') ?? '').not.toContain('CONFIRM_PRODUCTION')
  })

  test('release:rollback routes through release-guard with an explicit image', () => {
    const body = blocks.get('release:rollback') ?? ''
    expect(body).toContain('release-guard')
    expect(body).toContain('RELEASE_IMAGE: "{{.RELEASE_IMAGE}}"')
    expect(body).toContain('--image "$RELEASE_IMAGE" --rollback')
  })

  test('release:rollback pins an explicit config (FIND-04: never implicit ./fly.toml)', () => {
    const body = blocks.get('release:rollback') ?? ''
    expect(body).toContain('FLY_CONFIG: "{{.FLY_CONFIG}}"')
    expect(body).toContain('-c "$FLY_CONFIG"')
  })

  test('fly:deploy passes production confirmation through to the unified guard (F2)', () => {
    const body = blocks.get('fly:deploy') ?? ''
    expect(body).toContain('CONFIRM_PRODUCTION: "{{.CONFIRM_PRODUCTION}}"')
  })

  test.each(['deploy:dev', 'deploy:staging', 'deploy:production'])(
    '%s deploys an explicit digest, never rebuilds (FIND-10)',
    (task) => {
      const body = blocks.get(task) ?? ''
      expect(body).toContain('IMAGE_DIGEST: "{{.IMAGE_DIGEST}}"')
      expect(body).toMatch(/test -n "\$IMAGE_DIGEST"/)
      expect(body).toContain('--image "$IMAGE_DIGEST"')
    },
  )

  test.each([
    ['promote:staging', 'openlevel-staging', 'fly.toml', 'openlevel-dev'],
    ['promote:production', 'openlevel-prod', 'fly.prod.toml', 'openlevel-staging'],
  ])('%s resolves the source digest once, guards it, then deploys it (FIND-10)', (task, app, config, source) => {
    const body = blocks.get(task) ?? ''
    expect(body).toContain(`FLY_APP: "${app}"`)
    expect(body).toContain(`FLY_CONFIG: "${config}"`)
    expect(body).toContain(`SOURCE_APP: "${source}"`)
    expect(body).toContain('resolve-deployed-digest')
    expect(body).toContain('fly-guard')
    // Single resolution shared by guard and deploy (no TOCTOU between them).
    expect(body).toMatch(/DIGEST="\$\(node scripts\/toolchain\.mjs resolve-deployed-digest\)"/)
    expect(body).toContain('IMAGE_DIGEST="$DIGEST" node scripts/toolchain.mjs fly-guard')
    expect(body).toContain('--image "$DIGEST"')
  })

  test('promote:production keeps the double confirmation', () => {
    const body = blocks.get('promote:production') ?? ''
    expect(body).toMatch(/test "\$CONFIRM_DEPLOY" = "yes"/)
    expect(body).toMatch(/test "\$CONFIRM_PRODUCTION" = "yes"/)
  })

  test('release:status is read-only (releases + status + image only)', () => {
    const body = blocks.get('release:status') ?? ''
    expect(body).toContain('fly releases -a "$FLY_APP"')
    expect(body).toContain('fly status -a "$FLY_APP"')
    expect(body).toContain('fly image show -a "$FLY_APP"')
    expect(body).not.toMatch(/fly deploy/)
  })

  test('env:status, env:validate, and secrets:status run local-only commands', () => {
    expect(blocks.get('env:status') ?? '').toContain('toolchain.mjs env status')
    expect(blocks.get('env:validate') ?? '').toContain('toolchain.mjs env validate')
    expect(blocks.get('secrets:status') ?? '').toContain('secret-store.mjs status')
    // Command lines only (descs may name the clouds in prose).
    const cmdLines = (task: string) =>
      (blocks.get(task) ?? '').split('\n').filter((l) => /^\s+- /.test(l)).join('\n')
    for (const task of ['env:status', 'env:validate', 'secrets:status']) {
      expect(cmdLines(task)).not.toMatch(/(^|\s)(fly|neon)(\s|$)/)
    }
  })
})

describe('dev environment wiring (P1-1)', () => {
  test.each(['dev', 'dev:api', 'dev:web', 'dev:health', 'dev:open'])('%s maps the OPENLEVEL_* contract', (task) => {
    const body = blocks.get(task) ?? ''
    expect(body).toContain('OPENLEVEL_HOST:')
    expect(body).toContain('OPENLEVEL_API_PORT:')
    expect(body).toContain('OPENLEVEL_WEB_PORT:')
  })

  test('dev:web carries no CLI host/port templates (bind lives in vite.config.ts)', () => {
    const body = blocks.get('dev:web') ?? ''
    expect(body).not.toContain('--host {{')
    expect(body).not.toContain('--port {{')
  })
})
