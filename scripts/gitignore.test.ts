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

test('Docker build context excludes secrets independently of git', () => {
  // .dockerignore is the image boundary; git rules alone do not protect it.
  const lines = readFileSync('.dockerignore', 'utf8')
    .split('\n')
    .map((l) => l.trim())
  for (const pattern of [
    '.env',
    '.env.*',
    '*.pem',
    '*.key',
    'creds.json',
    'secrets-export.json',
    '*-credentials.csv',
    'phase0/evidence/',
  ]) {
    expect(lines).toContain(pattern)
  }
})
