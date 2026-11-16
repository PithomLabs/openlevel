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
