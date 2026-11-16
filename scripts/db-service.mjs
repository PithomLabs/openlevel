#!/usr/bin/env node
/**
 * OpenLevel local-PostgreSQL helper (Prompt 29.2, spec Part II section 6).
 * Provider detection, service controls, and the loopback-only database
 * guard. Node builtins only. macOS/Linux only.
 *
 * This helper contains NO code path that runs initdb, pg_upgrade, data
 * migration, drop, or restore: installing a newer binary must never
 * auto-upgrade a cluster (approved safeguard). Major moves need a verified
 * backup + compatibility assessment + separate owner-approved migration.
 *
 *   node scripts/db-service.mjs detect|version|status|start|stop|create|guard|psql
 *
 * guard/psql/create read DATABASE_URL from the environment (never from .env
 * directly — the Taskfile has no dotenv stanza by design) and accept only a
 * parsed loopback host plus the exact local database name. Nothing secret is
 * ever printed: not the URL, password, token, or remote host/db names.
 */
import { execFileSync, execSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { platform } from 'node:os'
import { join } from 'node:path'
import { URL } from 'node:url'

const OS = platform()
const LOCAL_DB = 'openlevel'
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

function fail(message, code = 1) {
  console.error(`db: error: ${message}`)
  process.exit(code)
}

function assertPlatform() {
  if (OS !== 'darwin' && OS !== 'linux') fail(`unsupported OS '${OS}': db tasks support macOS and Linux only`)
}

/** Run a fixed shell command, return trimmed stdout or null. Never throws. */
function sh(cmd) {
  try {
    const out = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 8000 }).trim()
    return out === '' ? null : out
  } catch {
    return null
  }
}

function which(tool) {
  const found = sh(`command -v ${tool}`)
  return found !== null && !found.includes('\n') ? found : null
}

/**
 * Parse + enforce the local-only database policy. Returns the parsed URL.
 * Never echoes the URL, password, or any remote host/db value.
 */
function readDatabaseUrl() {
  const raw = process.env.DATABASE_URL ?? ''
  if (raw === '') {
    fail(
      'DATABASE_URL is not set. Export it for your LOCAL dev database ' +
        '(see .env.example for the convention) — never a Neon or production URL.',
      2,
    )
  }
  let url = null
  try {
    url = new URL(raw)
  } catch {
    fail('DATABASE_URL is malformed (not a valid URI). Refusing.', 2)
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    fail('DATABASE_URL must use the postgres:// scheme. Refusing.', 2)
  }
  if (!LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) {
    fail('DATABASE_URL host is not loopback. Refusing to touch a non-local database.', 2)
  }
  if (url.pathname.replace(/^\//, '') !== LOCAL_DB) {
    fail(`DATABASE_URL database is not the local dev database '${LOCAL_DB}'. Refusing.`, 2)
  }
  return url
}

function cmdGuard() {
  readDatabaseUrl()
  console.log(`database guard passed: loopback host, local dev database '${LOCAL_DB}' (details withheld by design)`)
}

function safeDecode(value, what) {
  try {
    return decodeURIComponent(value)
  } catch {
    fail(`DATABASE_URL ${what} is not valid percent-encoding. Refusing.`, 2)
  }
}

/** Plain host for libpq (WHATWG keeps IPv6 brackets; psql wants them gone). */
function psqlHost(url) {
  return url.hostname.replace(/^\[(.*)\]$/, '$1')
}

/** Discrete psql connection args — the URL (and password) never appear in argv. */
function psqlBaseArgs(url) {
  const args = ['-h', psqlHost(url), '-p', url.port === '' ? '5432' : url.port, '-d', LOCAL_DB]
  if (url.username !== '') args.push('-U', safeDecode(url.username, 'username'))
  return args
}

function psqlEnv(url) {
  const env = { ...process.env }
  if (url.password !== '') env.PGPASSWORD = safeDecode(url.password, 'password')
  return env
}

function cmdPsql() {
  const url = readDatabaseUrl()
  if (which('psql') === null) fail('psql not found — install local PostgreSQL per `task tools:plan`')
  const child = spawn('psql', psqlBaseArgs(url), { stdio: 'inherit', env: psqlEnv(url) })
  child.on('error', (err) => fail(`cannot start psql: ${err.message}`))
  child.on('exit', (code, signal) => {
    if (signal !== null) process.exit(1)
    process.exit(code ?? 1)
  })
}

/** Run SQL via psql against the guarded local server. Returns { status, stdout }. */
function runSql(url, dbname, sql) {
  const args = ['-h', psqlHost(url), '-p', url.port === '' ? '5432' : url.port, '-d', dbname]
  if (url.username !== '') args.push('-U', safeDecode(url.username, 'username'))
  args.push('-v', 'ON_ERROR_STOP=1', '-tAX', '-c', sql)
  const res = spawnSync('psql', args, { encoding: 'utf8', env: psqlEnv(url), timeout: 30000 })
  return { status: res.status ?? 1, stdout: (res.stdout ?? '').trim(), stderr: (res.stderr ?? '').trim() }
}

function cmdCreate() {
  const url = readDatabaseUrl()
  if (which('psql') === null) fail('psql not found — install local PostgreSQL per `task tools:plan`')
  const role = runSql(url, 'postgres', `SELECT 1 FROM pg_roles WHERE rolname = '${LOCAL_DB}'`)
  if (role.status !== 0) {
    fail(
      `cannot inspect local roles (${role.stderr || 'connection failed'}). ` +
        `Is the local server running (task db:status) and is DATABASE_URL correct?`,
    )
  }
  if (role.stdout !== '1') {
    const created = runSql(url, 'postgres', `CREATE ROLE ${LOCAL_DB} WITH LOGIN`)
    if (created.status !== 0) {
      console.error(`db: CREATE ROLE failed (${created.stderr || 'see server log'}). Owner SQL for a superuser psql session:`)
      console.error(`  CREATE ROLE ${LOCAL_DB} WITH LOGIN;`)
      if (url.password !== '') console.error(`  ALTER ROLE ${LOCAL_DB} WITH PASSWORD '<the password from your own DATABASE_URL>';`)
      process.exit(3)
    }
    console.log(`role '${LOCAL_DB}' created`)
    if (url.password !== '') {
      console.log(`role '${LOCAL_DB}' has no password yet — set it from your own DATABASE_URL:`)
      console.log(`  ALTER ROLE ${LOCAL_DB} WITH PASSWORD '<the password from your own DATABASE_URL>';`)
    }
  } else {
    console.log(`role '${LOCAL_DB}' already exists (left untouched)`)
  }
  const db = runSql(url, 'postgres', `SELECT 1 FROM pg_database WHERE datname = '${LOCAL_DB}'`)
  if (db.status !== 0) fail(`cannot inspect local databases (${db.stderr || 'connection failed'})`)
  if (db.stdout !== '1') {
    const created = runSql(url, 'postgres', `CREATE DATABASE ${LOCAL_DB} OWNER ${LOCAL_DB}`)
    if (created.status !== 0) {
      console.error(`db: CREATE DATABASE failed (${created.stderr || 'see server log'}). Owner SQL for a superuser psql session:`)
      console.error(`  CREATE DATABASE ${LOCAL_DB} OWNER ${LOCAL_DB};`)
      process.exit(3)
    }
    console.log(`database '${LOCAL_DB}' created`)
  } else {
    console.log(`database '${LOCAL_DB}' already exists (left untouched)`)
  }
}

function subdirs(path) {
  try {
    return readdirSync(path, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return []
  }
}

function detectProvider() {
  const found = []
  if (OS === 'darwin') {
    if (which('brew') !== null && sh('brew --version') !== null) found.push('brew')
    if (existsSync('/Applications/Postgres.app')) found.push('postgresapp')
    if (subdirs('/Library/PostgreSQL').length > 0) found.push('edb')
    if (which('port') !== null) found.push('macports')
  } else if (OS === 'linux') {
    if (which('systemctl') !== null) found.push('systemd')
    if (which('pg_lsclusters') !== null) found.push('pg_lsclusters')
    if (which('service') !== null) found.push('service-script')
    if (which('rc-service') !== null) found.push('openrc')
  }
  return found
}

function findPgCtl() {
  if (which('pg_ctl') !== null) return which('pg_ctl')
  for (const base of ['/Library/PostgreSQL', '/Applications/Postgres.app/Contents/Versions']) {
    const vers = subdirs(base).sort().reverse()
    for (const v of vers) {
      const candidate = join(base, v, 'bin', 'pg_ctl')
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

/** Best-effort data-directory major check. Refuses start on proven mismatch. */
function dataDirMajorClash() {
  const dirs = []
  for (const base of ['/Library/PostgreSQL']) {
    for (const v of subdirs(base)) dirs.push(join(base, v, 'data'))
  }
  for (const dir of dirs) {
    const marker = join(dir, 'PG_VERSION')
    if (!existsSync(marker)) continue
    const pgCtl = findPgCtl()
    const binMajor = pgCtl === null ? null : sh(`"${pgCtl}" --version | grep -oE '[0-9]+' | head -n 1`)
    let dataMajor = null
    try {
      dataMajor = readFileSync(marker, 'utf8').trim()
    } catch {
      dataMajor = null
    }
    if (binMajor !== null && dataMajor !== null && binMajor !== dataMajor) return { dir, binMajor, dataMajor }
  }
  return null
}

function cmdDetect() {
  console.log(`provider candidates: ${detectProvider().join(', ') || 'none detected'}`)
  console.log(`psql: ${which('psql') ?? 'MISSING'}`)
  console.log(`pg_ctl: ${findPgCtl() ?? 'not found'}`)
  console.log(`pg_isready: ${which('pg_isready') ?? 'MISSING'}`)
}

function cmdVersion() {
  if (which('psql') !== null) {
    try {
      console.log(execFileSync('psql', ['--version'], { encoding: 'utf8' }).trim())
      return
    } catch {
      /* fall through */
    }
  }
  const pgCtl = findPgCtl()
  if (pgCtl !== null) {
    const out = sh(`"${pgCtl}" --version`)
    if (out !== null) {
      console.log(out)
      return
    }
  }
  fail('no local PostgreSQL binaries found — see `task tools:plan`')
}

function cmdStatus() {
  if (which('pg_isready') !== null) {
    const res = spawnSync('pg_isready', ['-h', '127.0.0.1', '-p', '5432'], { encoding: 'utf8', timeout: 10000 })
    process.stdout.write(res.stdout ?? '')
    process.stderr.write(res.stderr ?? '')
  } else {
    console.log('pg_isready not found — install local PostgreSQL per `task tools:plan`')
  }
  if (OS === 'linux' && which('pg_lsclusters') !== null) {
    const clusters = sh('pg_lsclusters')
    if (clusters !== null) console.log(clusters)
  }
}

function cmdStartStop(action) {
  const clash = dataDirMajorClash()
  if (clash !== null) {
    fail(
      `refusing to ${action}: server binary is PG${clash.binMajor} but ${clash.dir} holds PG${clash.dataMajor}. ` +
        `Major moves need a verified backup + compatibility assessment + separate owner-approved migration.`,
    )
  }
  const providers = detectProvider()
  if (OS === 'darwin' && providers.includes('brew')) {
    const listed = sh('brew services list 2>/dev/null | grep -E "^postgresql" | head -n 1')
    const formula = listed === null ? null : listed.split(/\s+/)[0]
    if (formula === null) {
      fail('brew is present but no postgresql formula looks installed — see `task tools:plan`', 3)
    }
    const res = spawnSync('brew', ['services', action, formula], { encoding: 'utf8', timeout: 60000 })
    process.stdout.write(res.stdout ?? '')
    process.stderr.write(res.stderr ?? '')
    if (res.status !== 0) process.exit(res.status ?? 1)
    return
  }
  if (OS === 'linux' && providers.includes('pg_lsclusters') && which('pg_ctlcluster') !== null) {
    console.log(`owner command (needs sudo): sudo pg_ctlcluster <version> <cluster> ${action}`)
    console.log('This helper never runs sudo itself — run the exact command above, then `task db:status`.')
    process.exit(3)
  }
  if (OS === 'linux' && providers.includes('systemd')) {
    console.log(`owner command (needs sudo): sudo systemctl ${action} postgresql`)
    console.log('This helper never runs sudo itself — run the exact command above, then `task db:status`.')
    process.exit(3)
  }
  const pgCtl = findPgCtl()
  if (pgCtl !== null && OS === 'darwin' && providers.includes('postgresapp')) {
    console.log(`Postgres.app detected — start/stop it from the menu-bar elephant, or run pg_ctl directly:`)
    console.log(`  "${pgCtl}" -D <data-dir> -l <logfile> ${action}`)
    process.exit(3)
  }
  fail(
    `no safe service route detected (providers: ${providers.join(', ') || 'none'}). ` +
      `Start your PostgreSQL provider manually, then run \`task db:status\`.`,
    3,
  )
}

function main() {
  assertPlatform()
  const sub = process.argv[2]
  if (sub === 'detect') cmdDetect()
  else if (sub === 'version') cmdVersion()
  else if (sub === 'status') cmdStatus()
  else if (sub === 'start') cmdStartStop('start')
  else if (sub === 'stop') cmdStartStop('stop')
  else if (sub === 'create') cmdCreate()
  else if (sub === 'guard') cmdGuard()
  else if (sub === 'psql') cmdPsql()
  else fail('usage: db-service.mjs <detect|version|status|start|stop|create|guard|psql>', 2)
}

main()
