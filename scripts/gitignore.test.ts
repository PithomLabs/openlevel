/**
 * FIND-02 regression: secret-bearing filenames must be git-ignored even when
 * they differ from the exact `.env` name, while intended templates stay
 * trackable. Uses `git check-ignore` (no files created) plus tracked-file
 * assertions for the exceptions.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

function isIgnored(path: string): boolean {
  try {
    execFileSync('git', ['check-ignore', '-q', path], { encoding: 'utf8' })
    return true
  } catch {
    return false
  }
}

function isTracked(path: string): boolean {
  try {
    const out = execFileSync('git', ['ls-files', '--', path], { encoding: 'utf8' })
    return out.trim() === path
  } catch {
    return false
  }
}

test.each(['.env', '.env.local', '.env.production', '.env.staging', 'phase0/.env'])(
  'secret env file %p is ignored',
  (p) => {
    expect(isIgnored(p)).toBe(true)
  },
)

test.each(['.ENV', '.Env', '.ENV.production', '.eNv.local'])(
  'FIND-02: case-variant env file %p is ignored on Linux',
  (p) => {
    expect(isIgnored(p)).toBe(true)
  },
)

test.each(['id_rsa.pem', 'certs/tls.key', 'deploy.key', 'ca.pem'])(
  'private-key file %p is ignored',
  (p) => {
    expect(isIgnored(p)).toBe(true)
  },
)

test.each([
  'creds.json',
  'downloads/creds.json',
  'credentials.json',
  'secrets-export.json',
  'exports/acme-credentials.csv',
  'exports/acme-credentials.json',
  'vault-backup.p12',
  'keystore.pfx',
  'upload-key.jks',
  'app.keystore',
  'id_rsa',
  'id_rsa_acme',
  'putty-key.ppk',
])('N6 credential-export file %p is ignored', (p) => {
  expect(isIgnored(p)).toBe(true)
})

test.each([
  'phase0/evidence/suite-P1-run-2026-11-19T03-27-33-745Z-26767.json',
  'phase0/evidence/app-suite.json',
])('generated run artifact %p is ignored', (p) => {
  expect(isIgnored(p)).toBe(true)
})

test('.env.example template stays trackable', () => {
  expect(isIgnored('.env.example')).toBe(false)
  expect(isTracked('.env.example')).toBe(true)
})

/**
 * FIND-02: minimal .dockerignore matcher with Docker's pattern semantics —
 * `*` (within a segment), `?`, `[...]` classes, trailing-`/` directory
 * subtrees, last-match-wins with `!` negation, and slash-less patterns
 * matching any directory level. This asserts what the rules AS WRITTEN
 * exclude (behavior of the file), not their spelling; the live CI image
 * check (`ls .env*` must fail inside the built image) stays the
 * ground-truth backstop.
 */
function dockerPatternToRegExp(pattern: string): RegExp {
  let out = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '*') {
      out += pattern[i + 1] === '*' ? '.*' : '[^/]*'
      if (pattern[i + 1] === '*') i++
    } else if (c === '?') {
      out += '[^/]'
    } else if (c === '[') {
      const close = pattern.indexOf(']', i + 1)
      if (close < 0) out += '\\['
      else {
        out += pattern.slice(i, close + 1)
        i = close
      }
    } else {
      out += c.replace(/[.+^${}()|\\]/, '\\$&')
    }
  }
  return new RegExp(`^${out}$`)
}

function isDockerExcluded(rules: string[], path: string): boolean {
  const clean = path.replace(/^\.\//, '')
  let excluded = false
  for (const raw of rules) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const negated = line.startsWith('!')
    const pattern = negated ? line.slice(1) : line
    let match: boolean
    if (pattern.endsWith('/')) {
      const dir = pattern.slice(0, -1)
      match = clean === dir || clean.startsWith(`${dir}/`)
    } else if (!pattern.includes('/')) {
      const base = clean.slice(clean.lastIndexOf('/') + 1)
      match = dockerPatternToRegExp(pattern).test(base)
    } else {
      match = dockerPatternToRegExp(pattern).test(clean)
    }
    if (match) excluded = !negated
  }
  return excluded
}

function dockerRules(): string[] {
  return readFileSync('.dockerignore', 'utf8').split('\n')
}

test.each([
  '.env',
  '.env.local',
  '.ENV',
  '.Env',
  '.ENV.production',
  'sub/dir/.env',
  'id_rsa.pem',
  'certs/tls.key',
  'deploy.key',
  'ca.pem',
  'creds.json',
  'downloads/creds.json',
  'credentials.json',
  'secrets-export.json',
  'exports/acme-credentials.csv',
  'exports/acme-credentials.json',
  'vault-backup.p12',
  'keystore.pfx',
  'upload-key.jks',
  'app.keystore',
  'id_rsa',
  'id_rsa_acme',
  'putty-key.ppk',
  'phase0/evidence/suite-P1-run-2026-11-19T03-27-33-745Z-26767.json',
  'phase0/evidence/app-suite.json',
])('FIND-02: Docker build context excludes secret-bearing %p', (p) => {
  expect(isDockerExcluded(dockerRules(), p)).toBe(true)
})

test('FIND-02: .env.example stays OUT of the Docker context (git trackability is separate)', () => {
  // Deliberate split: git must track the template (see the test above) while
  // the image build must not receive it — the production image needs no
  // env template. No negation is added to .dockerignore for this.
  expect(isDockerExcluded(dockerRules(), '.env.example')).toBe(true)
})

test.each(['server/index.ts', 'Dockerfile', 'package.json', 'src/lib/api.ts', 'db/migrations/001_init.sql'])(
  'FIND-02: Docker build context still includes legitimate %p',
  (p) => {
    expect(isDockerExcluded(dockerRules(), p)).toBe(false)
  },
)
