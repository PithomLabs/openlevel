#!/usr/bin/env node
/**
 * OpenLevel toolchain helper (Prompt 29.2, spec Part II sections 2-4, 8-9).
 * Host detection, compatible-version planning, environment doctor, guided
 * installs, and read-only cloud-CLI guards. Node builtins plus @iarna/toml
 * (real TOML parsing for the deploy guards — Review 11 parser finding).
 * Needs `npm ci` before use (CI installs it; see product-packaging.yml).
 * Never prints secrets. Never modifies the host except `install`/`upgrade`
 * with explicit confirmation, and then only safe per-user operations.
 *
 *   node scripts/toolchain.mjs detect [--json]
 *   node scripts/toolchain.mjs versions
 *   node scripts/toolchain.mjs gate
 *   node scripts/toolchain.mjs doctor
 *   node scripts/toolchain.mjs plan
 *   node scripts/toolchain.mjs install    (needs CONFIRM_TOOL_INSTALL=yes)
 *   node scripts/toolchain.mjs upgrade    (preview; CONFIRM_TOOL_UPGRADE=yes applies)
 *   node scripts/toolchain.mjs neon <projects|branches|diff|inspect>
 *   node scripts/toolchain.mjs fly-guard  (needs FLY_APP, FLY_CONFIG, CONFIRM_DEPLOY=yes; prod also CONFIRM_PRODUCTION=yes)
 *   node scripts/toolchain.mjs release-guard  (needs FLY_APP, FLY_CONFIG, RELEASE_IMAGE, CONFIRM_DEPLOY=yes; prod also CONFIRM_PRODUCTION=yes)
 *   node scripts/toolchain.mjs resolve-deployed-digest  (needs SOURCE_APP; prints its digest)
 *   node scripts/toolchain.mjs env <status|validate>
 */
import { execFileSync, execSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createServer } from 'node:net'
import { arch as osArch, homedir, platform } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import TOML from '@iarna/toml'
import { classifyBindError } from './lib/dev-env.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OS = platform()
const SUPPORTED_OS = OS === 'darwin' || OS === 'linux'

function fail(message, code = 1) {
  console.error(`toolchain: error: ${message}`)
  process.exit(code)
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

function capture(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', timeout: 10000 })
  } catch {
    return null
  }
}

function detectHost() {
  const info = {
    os: OS,
    osVersion: null,
    arch: osArch(),
    libc: null,
    distro: null,
    codename: null,
    model: null,
    clt: null,
    pkgManagers: [],
    nodeManagers: [],
    shell: process.env.SHELL ?? null,
  }
  if (OS === 'darwin') {
    info.osVersion = sh('sw_vers -productVersion')
    info.model = sh('sysctl -n hw.model')
    info.clt = sh('xcode-select -p')
    for (const pm of ['brew', 'port']) {
      if (which(pm)) info.pkgManagers.push(pm)
    }
  } else if (OS === 'linux') {
    try {
      const release = readFileSync('/etc/os-release', 'utf8')
      const get = (key) => {
        const line = release.split('\n').find((l) => l.startsWith(`${key}=`))
        return line === undefined ? null : line.slice(key.length + 1).replace(/^"|"$/g, '')
      }
      info.distro = get('PRETTY_NAME') ?? get('NAME')
      info.osVersion = get('VERSION_ID')
      info.codename = get('VERSION_CODENAME')
    } catch {
      /* leave distro fields null */
    }
    const gnu = sh('getconf GNU_LIBC_VERSION')
    if (gnu) {
      info.libc = `glibc ${gnu}`
    } else {
      const ldd = sh('ldd --version 2>&1 | head -n 1')
      info.libc = ldd !== null && /musl/i.test(ldd) ? `musl (${ldd})` : (ldd ?? 'unknown')
    }
    for (const pm of ['apt-get', 'dnf', 'yum', 'zypper', 'apk', 'pacman']) {
      if (which(pm)) info.pkgManagers.push(pm)
    }
  }
  if (process.env.NVM_DIR !== undefined || existsSync(join(homedir(), '.nvm'))) info.nodeManagers.push('nvm')
  for (const mgr of ['fnm', 'volta', 'mise']) {
    if (which(mgr)) info.nodeManagers.push(mgr)
  }
  return info
}

function cmdDetect(json) {
  const info = detectHost()
  if (json) {
    console.log(JSON.stringify(info, null, 2))
    return
  }
  console.log(`os        ${info.os}${info.osVersion ? ` ${info.osVersion}` : ''}`)
  if (info.distro) console.log(`distro    ${info.distro}${info.codename ? ` (${info.codename})` : ''}`)
  console.log(`arch      ${info.arch}`)
  if (info.libc) console.log(`libc      ${info.libc}`)
  if (info.model) console.log(`model     ${info.model}`)
  if (info.clt) console.log(`clt       ${info.clt}`)
  console.log(`pkg       ${info.pkgManagers.length > 0 ? info.pkgManagers.join(', ') : 'none detected'}`)
  console.log(`node-mgr  ${info.nodeManagers.length > 0 ? info.nodeManagers.join(', ') : 'none detected'}`)
  if (info.shell) console.log(`shell     ${info.shell}`)
}

function toolVersion(cmd, versionArg) {
  const path = which(cmd)
  if (path === null) return { cmd, path: null, version: null }
  let version = null
  if (versionArg !== null) {
    const out = capture(cmd, [versionArg])
    if (out !== null) version = out.trim().split('\n')[0] ?? null
  }
  return { cmd, path, version }
}

const VERSION_PROBES = [
  ['node', '--version'],
  ['npm', '--version'],
  ['psql', '--version'],
  ['pg_isready', null],
  ['task', '--version'],
  ['fly', 'version'],
  ['neon', '--version'],
]

function cmdVersions() {
  for (const [cmd, arg] of VERSION_PROBES) {
    const t = toolVersion(cmd, arg)
    if (t.path === null) console.log(`${cmd}: MISSING`)
    else console.log(`${cmd}: ${t.version ?? '(present, version unknown)'} [${t.path}]`)
  }
}

function cmdGate() {
  if (!SUPPORTED_OS) fail(`unsupported OS '${OS}': this Taskfile supports macOS and Linux only`)
}

function tryBind(port) {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', (err) => resolve({ free: false, ...classifyBindError(err) }))
    server.listen(port, '127.0.0.1', () => server.close(() => resolve({ free: true })))
  })
}

function nodeMajor(version) {
  const match = /^v?(\d+)\./.exec(version ?? '')
  return match === null ? null : Number.parseInt(match[1], 10)
}

async function cmdDoctor() {
  const rows = []
  const push = (name, status, detail) => rows.push({ name, status, detail })
  if (!SUPPORTED_OS) {
    push('os', 'FAIL', `unsupported OS '${OS}' (macOS/Linux only)`)
  } else {
    const info = detectHost()
    push('os', 'OK', `${info.os}${info.osVersion ? ` ${info.osVersion}` : ''} ${info.arch}`)
  }
  const node = toolVersion('node', '--version')
  if (node.path === null) {
    push('node', 'FAIL', 'not found — install Node 26 per `task tools:plan`, then retry')
  } else {
    const major = nodeMajor(node.version)
    if (major === null || major < 26) push('node', 'FAIL', `${node.version} is below engines >=26 — select Node 26`)
    else if (major !== 26) push('node', 'WARN', `${node.version}: repo + CI standardize on Node 26 — switch for this repo`)
    else push('node', 'OK', `${node.version} [${node.path}]`)
  }
  const npm = toolVersion('npm', '--version')
  push('npm', npm.path === null ? 'FAIL' : 'OK', npm.path === null ? 'not found (ships with Node)' : `${npm.version ?? '(present, version unknown)'} [${npm.path}]`)
  push('node_modules', existsSync(join(ROOT, 'node_modules')) ? 'OK' : 'FAIL', existsSync(join(ROOT, 'node_modules')) ? 'present' : 'missing — run `task deps:install`')
  push('.nvmrc', existsSync(join(ROOT, '.nvmrc')) ? 'OK' : 'WARN', existsSync(join(ROOT, '.nvmrc')) ? 'pins Node 26' : 'missing — project Node pin not found')
  const task = toolVersion('task', '--version')
  push('task', task.path === null ? 'WARN' : 'OK', task.path === null ? 'not found — install per `task tools:plan`' : `${task.version ?? '(present, version unknown)'} [${task.path}]`)
  const psql = toolVersion('psql', '--version')
  push('psql', 'INFO', psql.path === null ? 'not found (optional; needed only for native-PostgreSQL db:* tasks)' : `${psql.version ?? '(present, version unknown)'} [${psql.path}]`)
  const fly = toolVersion('fly', 'version')
  push('fly', 'INFO', fly.path === null ? 'not found (optional; needed only for fly:* tasks)' : `${fly.version ?? '(present, version unknown)'} [${fly.path}]`)
  const neon = toolVersion('neon', '--version')
  push('neon', 'INFO', neon.path === null ? 'not found (optional; needed only for neon:* tasks)' : `${neon.version ?? '(present, version unknown)'} [${neon.path}]`)
  for (const [label, port] of [['api-port', 8790], ['web-port', 5273]]) {
    const probe = await tryBind(port)
    if (probe.free) push(label, 'OK', `${port} free`)
    else if (probe.kind === 'denied') push(label, 'WARN', `${port} bind probe denied by environment (restricted session?)`)
    else if (probe.kind === 'unavailable')
      push(label, 'WARN', `${port} unavailable — probe address not present on this host`)
    else if (probe.kind === 'unknown') push(label, 'WARN', `${port} probe failed (unexpected error ${probe.code})`)
    else push(label, 'WARN', `${port} occupied — task dev will refuse until it is free`)
  }
  const width = Math.max(...rows.map((r) => r.name.length))
  for (const r of rows) console.log(`${r.name.padEnd(width)}  [${r.status}]  ${r.detail}`)
  if (rows.some((r) => r.status === 'FAIL')) {
    console.error('doctor: FAIL — fix the items above, then re-run `task doctor`')
    process.exit(1)
  }
  console.log('doctor: OK — required tools present (INFO/WARN items are optional or advisory)')
}

function darwinMajor(osVersion) {
  const match = /^(\d+)\./.exec(osVersion ?? '')
  return match === null ? null : Number.parseInt(match[1], 10)
}

function cmdPlan() {
  const info = detectHost()
  console.log(`Host: ${info.os}${info.osVersion ? ` ${info.osVersion}` : ''} ${info.arch}${info.libc ? ` ${info.libc}` : ''}`)
  console.log('Policy: newest STABLE version compatible with this host — never EOL, beta, RC, or odd Current.')
  console.log('Re-check the live official sources below before installing anything (snapshot: 2026-11-16).')
  console.log('')
  console.log('[node-26] REQUIRED — project runtime (engines >=26, CI pins 26).')
  console.log('  route: latest Node 26.x patch via the existing manager, else fnm (official darwin/linux assets).')
  console.log('  compat: Active LTS needs macOS 13.5+; Linux Tier 1 needs glibc >=2.28.')
  console.log('  pin: .nvmrc selects 26; fresh shells must resolve Node 26 inside this repo.')
  console.log('  verify: node --version  →  v26.x')
  console.log('  sources: https://nodejs.org/en/about/previous-releases')
  console.log('           https://github.com/nodejs/node/blob/v26.x/BUILDING.md')
  console.log('')
  const dm = info.os === 'darwin' ? darwinMajor(info.osVersion) : null
  if (dm !== null && dm < 13) {
    console.log('[node-26] BLOCKED on this host — Node 26 binaries need macOS 13.5+; upgrade the host, never downgrade the repo runtime.')
  } else {
    console.log('[node-next] OPTIONAL — newer Current alongside 26 only for evaluation; never the repo runtime.')
  }
  console.log('  sources: https://nodejs.org/en/about/previous-releases')
  console.log('')
  if (info.os === 'darwin' && dm !== null && dm < 13) {
    console.log('[postgres] newest stable patch of the PG17 line (PG18 macOS installers target 13+; never PG19 RC).')
    console.log('  route: EDB installer for PG17 (owner runs the .pkg — admin password, inspect first).')
  } else if (info.os === 'darwin') {
    console.log('[postgres] newest stable PG18 patch where official macOS support exists (never PG19 RC).')
    console.log('  route: EDB installer, Postgres.app, MacPorts, or brew only if `brew config` shows a supported tier.')
  } else if (info.os === 'linux') {
    console.log('[postgres] newest stable major supported for this exact distro/arch (never beta/RC).')
    console.log('  route: official PGDG repo when the codename is listed; else evaluate the distro-maintained package.')
  } else {
    console.log('[postgres] unsupported OS — no route offered.')
  }
  console.log('  SAFEGUARD: installing a newer binary must NEVER auto-upgrade a data cluster.')
  console.log('    Major moves need a verified backup + compatibility assessment + separate owner-approved migration.')
  console.log('  verify: psql --version ; pg_isready')
  console.log('  sources: https://www.postgresql.org/download/macosx/  https://www.postgresql.org/download/linux/')
  console.log('')
  console.log('[task] latest stable Task CLI for this OS/arch (per-user install preferred).')
  console.log('  route: supported system package, else the official installer into ~/.local/bin (inspect script, checksum verified).')
  console.log('  verify: task --version')
  console.log('  sources: https://taskfile.dev/docs/installation')
  console.log('')
  console.log('[fly] latest stable flyctl for this OS/arch (per-user install preferred).')
  console.log('  route: official Fly installer or release asset (inspect script, verify checksum/signature when published).')
  console.log('  verify: fly version ; fly help     — never auth/login/deploy as part of setup.')
  console.log('  sources: https://fly.io/docs/flyctl/installing')
  console.log('')
  console.log('[neon] latest stable `neon` CLI (npm package needs Node >=20.19 — Node 26 satisfies it).')
  console.log('  route: npm install --global neon@latest under Node 26; else the exact OS/arch standalone binary with integrity check.')
  console.log('  verify: neon --version ; neon --help     — never auth/init/link/env-pull as part of setup.')
  console.log('  sources: https://neon.com/docs/cli  https://www.npmjs.com/package/neon')
  console.log('')
  console.log('Apply safe per-user steps with: task tools:install CONFIRM_TOOL_INSTALL=yes')
  console.log('Admin-gated steps print the exact owner command and wait — passwords are never handled here.')
}

function cmdInstall() {
  if (process.env.CONFIRM_TOOL_INSTALL !== 'yes') {
    fail('refusing: re-run with CONFIRM_TOOL_INSTALL=yes (preview with `task tools:plan`)', 2)
  }
  cmdGate()
  const pending = []
  const node = toolVersion('node', '--version')
  const major = nodeMajor(node.version)
  if (node.path !== null && major === 26) {
    console.log(`[node-26] ALREADY_COMPATIBLE ${node.version}`)
  } else {
    pending.push('[node-26] owner action: install the latest Node 26.x patch (see `task tools:plan`), then re-run')
  }
  for (const [label, cmd, arg, hint] of [
    ['task', 'task', '--version', 'official installer into ~/.local/bin (inspect the script first)'],
    ['fly', 'fly', 'version', 'official Fly installer or release asset into ~/.local/bin (inspect first)'],
    ['psql', 'psql', '--version', 'EDB/PGApp/MacPorts/PGDG per `task tools:plan` — admin-gated, owner runs it'],
  ]) {
    const t = toolVersion(cmd, arg)
    if (t.path !== null) console.log(`[${label}] ALREADY_COMPATIBLE ${t.version ?? t.path}`)
    else pending.push(`[${label}] owner action: install latest stable via ${hint}`)
  }
  const neon = toolVersion('neon', '--version')
  if (neon.path !== null) {
    console.log(`[neon] ALREADY_COMPATIBLE ${neon.version ?? neon.path}`)
  } else if (node.path !== null && major !== null && major >= 26) {
    console.log('[neon] attempting per-user install: npm install --global neon@latest')
    const res = spawnSync('npm', ['install', '--global', 'neon@latest'], { encoding: 'utf8', timeout: 120000 })
    if (res.status === 0 && which('neon') !== null) console.log('[neon] INSTALLED')
    else pending.push('[neon] owner action: `npm install --global neon@latest` under Node 26 failed here — run it, or use the standalone binary')
  } else {
    pending.push('[neon] owner action: install Node 26 first, then `npm install --global neon@latest`')
  }
  console.log('[postgres-cluster] POLICY: no automatic major upgrade — backup + assessment + separate owner-approved migration only.')
  if (pending.length > 0) {
    console.log('')
    console.log('Remaining owner actions:')
    for (const p of pending) console.log(`  ${p}`)
    process.exit(3)
  }
  console.log('All tools already compatible — nothing to install.')
}

function cmdUpgrade() {
  if (process.env.CONFIRM_TOOL_UPGRADE !== 'yes') {
    console.log('Upgrade preview (nothing applied). Re-run with CONFIRM_TOOL_UPGRADE=yes to apply safe per-user steps.')
    console.log('Node major changes are NEVER applied automatically — the repo stays on Node 26.')
    console.log('')
    cmdVersions()
    console.log('')
    cmdPlan()
    return
  }
  console.log('Applying safe per-user steps (Node majors excluded by policy).')
  process.env.CONFIRM_TOOL_INSTALL = 'yes'
  cmdInstall()
}

/** Read-only Neon runner. Syntax is validated against installed help before exec. */
const NEON_OPS = {
  projects: { group: 'projects', op: 'list', needId: false },
  branches: { group: 'branches', op: 'list', needId: true },
  // Verified against neon 2.35.1: the sub-command is `schema-diff` (there is
  // no `branches diff`). Branch names are optional CLI positionals.
  diff: { group: 'branches', op: 'schema-diff', needId: true },
}

function neonExec(group, op, needId) {
  if (which('neon') === null) fail('neon CLI not installed — see `task tools:plan`')
  const id = process.env.PROJECT_ID ?? ''
  if (needId && id === '') fail('PROJECT_ID is required: e.g. task neon:branches PROJECT_ID=<id>')
  const top = capture('neon', ['--help'])
  if (top === null || !top.includes(group)) fail(`installed neon CLI has no '${group}' group — see \`neon --help\``)
  const groupHelp = capture('neon', [group, '--help'])
  // Adjacent `group op` match: a bare `includes(op)` false-positives
  // (`schema-diff` contains `diff`), which once hid a renamed sub-command.
  if (groupHelp === null || !groupHelp.includes(`${group} ${op}`)) {
    fail(`installed neon CLI has no '${group} ${op}' — see \`neon ${group} --help\``)
  }
  const args = [group, op]
  if (needId) {
    const opHelp = capture('neon', [group, op, '--help'])
    if (opHelp === null || !opHelp.includes('--project-id')) {
      fail(`installed neon CLI: '${group} ${op}' documents no --project-id flag — see \`neon ${group} ${op} --help\``)
    }
    args.push('--project-id', id)
  }
  if (group === 'branches' && op === 'schema-diff') {
    for (const v of [process.env.BRANCH_BASE ?? '', process.env.BRANCH_COMPARE ?? '']) {
      if (v !== '') args.push(v)
    }
  }
  const res = spawnSync('neon', args, { encoding: 'utf8', timeout: 60000 })
  const combined = `${res.stdout ?? ''}\n${res.stderr ?? ''}`
  if (/not authenticated|authentication required|please (log ?in|authenticate)|unauthorized/i.test(combined)) {
    console.log('SKIPPED — owner authentication required (no login attempted)')
    return
  }
  process.stdout.write(res.stdout ?? '')
  process.stderr.write(res.stderr ?? '')
  if (res.status !== 0) process.exit(res.status ?? 1)
}

function cmdNeon(name) {
  if (name === 'inspect') {
    neonExec('projects', 'list', false)
    if ((process.env.PROJECT_ID ?? '') !== '') neonExec('branches', 'list', true)
    else console.log('(pass PROJECT_ID=<id> to include branch listing)')
    return
  }
  const op = NEON_OPS[name]
  if (op === undefined) fail(`unknown neon view '${name}': use projects, branches, diff, or inspect`, 2)
  neonExec(op.group, op.op, op.needId)
}

/**
 * Seven-condition guard for every fly deploy path. Fails closed:
 *  1. FLY_APP must be supplied.            2. FLY_CONFIG must be supplied.
 *  3. The config file must exist (inside the repo — realpath containment
 *     closes absolute-path and symlink escapes outside the checkout).
 *  4. The P2 proof config is categorically refused (canonical path + a
 *     content belt: anything declaring the P2 app refuses too).
 *  5. The config's declared `app` must match FLY_APP exactly; a config
 *     declaring no app is malformed and refuses.
 *  6. CONFIRM_DEPLOY=yes must be present (owner authorization).
 *  7. No silent inference: this guard supplies no default app, config, or
 *     region — reaching the end means every value was explicit.
 */
/**
 * Exact environment-to-application mapping for deploy guards. Mirrors
 * server/lib/db-identity.ts ENV_APP_MAP (pinned equal by
 * scripts/fly-guard.test.ts). Production status derives from this table —
 * never from substring-matching an app name (Review 11 G1).
 */
export const ENV_APP_MAP = {
  development: 'openlevel-dev',
  staging: 'openlevel-staging',
  production: 'openlevel-prod',
}

export function isProductionApp(app) {
  return app === ENV_APP_MAP.production
}

/** Fly app names appear in DNS (<app>.fly.dev, <app>.internal), so they must
 *  be DNS-label-safe. This rejects control characters, slashes, spaces, and
 *  other values that could smuggle shell/flag meaning into fly commands. */
export function isValidAppName(app) {
  return typeof app === 'string' && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(app)
}

/**
 * Parse a fly config with a real TOML parser (Review 11 parser finding).
 * Throws a fail-closed Error on malformed TOML, duplicate keys, a missing
 * or non-string `app`, or a DNS-unsafe app name. Returns the parsed document.
 */
export function parseFlyConfig(body, label) {
  let doc = null
  try {
    doc = TOML.parse(body)
  } catch (err) {
    throw new Error(`refusing: ${label} is not valid TOML (${err instanceof Error ? err.message.split('\n')[0] : err})`)
  }
  if (typeof doc.app !== 'string' || doc.app === '') {
    throw new Error(`refusing: ${label} declares no app name`)
  }
  if (!isValidAppName(doc.app)) {
    throw new Error(`refusing: ${label} declares an invalid app name ${JSON.stringify(doc.app)}`)
  }
  return doc
}

/**
 * Shared app+config target validation for every deploy/rollback path (FIND-04,
 * F2). One authoritative check so no entry point can bypass another's rules:
 * explicit app, explicit in-repo config, P2 refusal, real TOML parse,
 * config↔app match. Deploy additionally requires an owner-confirmed
 * primary_region (rollback reuses existing machines, so it does not place any).
 */
export function assertFlyTarget(app, config, { hint, needRegion }) {
  if (app === '') fail(`FLY_APP is required: ${hint}`, 2)
  if (config === '') fail(`FLY_CONFIG is required: ${hint}`, 2)
  if (!isValidAppName(app)) fail(`refusing: FLY_APP is not a valid app name: ${JSON.stringify(app)}`, 2)
  const rootReal = realpathSync(ROOT)
  let real = null
  try {
    real = realpathSync(resolve(ROOT, config))
  } catch {
    fail(`FLY_CONFIG does not exist: ${config}`, 2)
  }
  if (real !== rootReal && !real.startsWith(rootReal + sep)) {
    fail(`refusing: FLY_CONFIG must live inside the repo: ${config}`, 2)
  }
  let p2real = null
  try {
    p2real = realpathSync(resolve(ROOT, join('phase0', 'p2', 'fly.staging.toml')))
  } catch {
    p2real = null
  }
  if (p2real !== null && real === p2real) {
    fail('refusing: phase0/p2/fly.staging.toml is the isolated P2 proof, never a product deploy target', 2)
  }
  let body = null
  try {
    body = readFileSync(real, 'utf8')
  } catch {
    fail(`FLY_CONFIG is not readable: ${config}`, 2)
  }
  if (body.includes('openlevel-p2-staging')) {
    fail('refusing: that config declares the P2 staging app, not a product app', 2)
  }
  let doc = null
  try {
    doc = parseFlyConfig(body, `FLY_CONFIG ${config}`)
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err), 2)
  }
  if (doc.app !== app) {
    fail(`refusing: FLY_CONFIG declares app "${doc.app}" but FLY_APP is "${app}"`, 2)
  }
  if (needRegion && (typeof doc.primary_region !== 'string' || doc.primary_region === '')) {
    fail(
      `refusing: ${config} sets no primary_region — owner must confirm the pilot geography and set it (runbook §8) before any deploy`,
      2,
    )
  }
  return doc
}

/** Production needs CONFIRM_PRODUCTION=yes on top of CONFIRM_DEPLOY=yes, on
 *  every path (F2: the generic task cannot bypass the specific one). */
function assertProdConfirm(app, confirmProd, what) {
  if (isProductionApp(app) && confirmProd !== 'yes') {
    fail(`refusing: production ${what} needs CONFIRM_PRODUCTION=yes on top of CONFIRM_DEPLOY=yes`, 2)
  }
}

/**
 * Digest-pinned image refs only (FIND-10): name@sha256:<64 hex>. Tags are
 * mutable, so a tag can silently resolve to a different image between
 * verification and deploy — promotion and rollback alike refuse anything
 * else. Exported for unit tests.
 */
export function assertImageDigest(image, what) {
  if (typeof image !== 'string' || !/^[^@\s]+@sha256:[0-9a-f]{64}$/.test(image)) {
    fail(
      `refusing: ${what} must be a digest-pinned image ref (name@sha256:<64 hex>), got ${JSON.stringify(image) ?? 'nothing'}`,
      2,
    )
  }
}

function cmdFlyGuard() {
  const app = process.env.FLY_APP ?? ''
  const config = process.env.FLY_CONFIG ?? ''
  const confirm = process.env.CONFIRM_DEPLOY ?? ''
  const confirmProd = process.env.CONFIRM_PRODUCTION ?? ''
  const digest = process.env.IMAGE_DIGEST ?? ''
  const hint = 'task fly:deploy FLY_APP=<app> FLY_CONFIG=<path> CONFIRM_DEPLOY=yes'
  assertFlyTarget(app, config, { hint, needRegion: true })
  if (confirm !== 'yes') fail('refusing: set CONFIRM_DEPLOY=yes — owner authorization is required for any deploy', 2)
  assertProdConfirm(app, confirmProd, 'deploy')
  // Deploy tasks set IMAGE_DIGEST (validated here); bare guard use without
  // one keeps working for target-only validation.
  if (digest !== '') assertImageDigest(digest, 'IMAGE_DIGEST')
  console.log(`fly deploy guard passed (app=${app} config=${config}; no secrets shown)`)
}

/**
 * Guard for task release:rollback. App, config, and image are all explicit
 * (FIND-04: the task always passes -c, so Fly can never infer ./fly.toml for
 * another app); the image is digest-pinned (FIND-10: tags and "previous" are
 * ambiguous under concurrent deploys); production needs a SECOND confirmation.
 * Fails closed.
 */
function cmdReleaseGuard() {
  const app = process.env.FLY_APP ?? ''
  const config = process.env.FLY_CONFIG ?? ''
  const image = process.env.RELEASE_IMAGE ?? ''
  const confirm = process.env.CONFIRM_DEPLOY ?? ''
  const confirmProd = process.env.CONFIRM_PRODUCTION ?? ''
  const hint = 'task release:rollback FLY_APP=<app> FLY_CONFIG=<path> RELEASE_IMAGE=<ref> CONFIRM_DEPLOY=yes'
  assertFlyTarget(app, config, { hint, needRegion: false })
  if (image === '') fail(`RELEASE_IMAGE is required: ${hint} — name the exact image digest to restore`, 2)
  assertImageDigest(image, 'RELEASE_IMAGE')
  if (confirm !== 'yes') fail('refusing: set CONFIRM_DEPLOY=yes — owner authorization is required for any rollback', 2)
  assertProdConfirm(app, confirmProd, 'rollback')
  console.log(`release rollback guard passed (app=${app} config=${config} image=${image}; no secrets shown)`)
}

/**
 * Extract the deployed image digest from `fly image show --json` output
 * (FIND-10 promotion check). The exact flyctl JSON shape is not pinned here:
 * every candidate is validated as a digest ref, and anything unrecognized
 * fails closed (a promotion that cannot PROVE the source digest must not run
 * on a guess). Exported for unit tests with fixture payloads.
 */
export function parseDeployedDigest(stdout, app) {
  let doc = null
  try {
    doc = JSON.parse(stdout)
  } catch {
    throw new Error(`refusing: could not parse \`fly image show\` output for ${app}`)
  }
  const candidates = [doc?.Digest, doc?.digest, doc?.ImageDigest, doc?.Image, doc?.image]
    .flatMap((v) => (typeof v === 'string' ? [v] : v != null && typeof v === 'object' ? Object.values(v) : []))
    .filter((v) => typeof v === 'string')
  for (const candidate of candidates) {
    if (/^[^@\s]+@sha256:[0-9a-f]{64}$/.test(candidate)) return candidate
  }
  const embedded = /[\w./-]+@sha256:[0-9a-f]{64}/.exec(stdout)?.[0]
  if (embedded) return embedded
  throw new Error(`refusing: no digest-shaped image ref found in \`fly image show\` output for ${app}`)
}

/**
 * Print the currently deployed digest of SOURCE_APP (read-only). Used by the
 * promote:* tasks to resolve the exact digest under promotion; fails closed
 * on missing CLI, auth errors, or unrecognized output.
 */
function cmdResolveDeployedDigest() {
  const app = process.env.SOURCE_APP ?? ''
  if (app === '') fail('SOURCE_APP is required: the promotion source app', 2)
  if (which('fly') === null) fail('fly CLI not installed — see `task tools:plan`')
  const res = spawnSync('fly', ['image', 'show', '-a', app, '--json'], { encoding: 'utf8', timeout: 60000 })
  const combined = `${res.stdout ?? ''}\n${res.stderr ?? ''}`
  if (/not authenticated|authentication required|please (log ?in|authenticate)|unauthorized|no access token/i.test(combined)) {
    fail('refusing: owner Fly authentication required (no login attempted)', 2)
  }
  if (res.status !== 0) {
    fail(`refusing: \`fly image show\` failed for ${app}: ${combined.slice(0, 300)}`, 2)
  }
  let digest = null
  try {
    digest = parseDeployedDigest(res.stdout ?? '', app)
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err), 2)
  }
  console.log(digest)
}

/** `app` declared by a fly config body, or '' when malformed (real TOML parse). */
export function flyDeclaredApp(body) {
  try {
    return parseFlyConfig(body, 'config').app
  } catch {
    return ''
  }
}

/** Keys present in the config's [env] table (real TOML parse). */
export function flyEnvKeys(body) {
  try {
    const doc = TOML.parse(body)
    if (doc.env === null || typeof doc.env !== 'object' || Array.isArray(doc.env)) return new Set()
    return new Set(Object.keys(doc.env))
  } catch {
    return new Set()
  }
}

/** Read-only local environment report. No cloud calls, no secret values. */
function cmdEnvStatus() {
  const node = toolVersion('node', '--version')
  const major = nodeMajor(node.version)
  console.log(`runtime: ${node.version ?? 'missing'} (repo requires Node 26; .nvmrc pins 26)`)
  if (node.path === null || major === null || major < 26) console.log('runtime: BELOW engines >=26 — switch before deploying')
  for (const [file, want] of [
    ['fly.toml', 'openlevel-staging'],
    ['fly.dev.toml', 'openlevel-dev'],
    ['fly.prod.toml', 'openlevel-prod'],
  ]) {
    const abs = join(ROOT, file)
    if (!existsSync(abs)) {
      console.log(`${file}: MISSING (expected app ${want})`)
      continue
    }
    const declared = flyDeclaredApp(readFileSync(abs, 'utf8'))
    console.log(`${file}: ${declared === '' ? 'MALFORMED (no app key)' : `app=${declared}`}${declared === want ? '' : ` (expected ${want})`}`)
  }
  console.log(`image: ${existsSync(join(ROOT, 'Dockerfile')) ? 'Dockerfile present' : 'Dockerfile MISSING'}`)
  console.log(
    `migrations: ${existsSync(join(ROOT, 'db', 'migrations', '20261119000000_baseline.sql')) ? 'dbmate baseline present' : 'dbmate baseline MISSING'}`,
  )
  console.log('database: local PGlite (dev) / ephemeral containers (verification); cloud targets are owner-provisioned')
  console.log('providers: stubbed/sandboxed by default; no production credentials on this workstation')
}

/**
 * Fail-closed local validation of the deployable surface. Every product fly
 * config must exist, be valid TOML, declare its conventional app, carry the
 * required [env] keys, define a release_command, and keep kill_* top-level.
 * Regions are NOT validated here: owner-confirmed primary_region is required
 * by the deploy guard instead, so CI stays green while provisioning is
 * correctly blocked on the outstanding owner input (Review 11 F3).
 */
function cmdEnvValidate() {
  const failures = []
  const node = toolVersion('node', '--version')
  const major = nodeMajor(node.version)
  if (node.path === null || major === null || major < 26) {
    failures.push(`node ${node.version ?? 'missing'} is below engines >=26`)
  }
  if (!existsSync(join(ROOT, 'Dockerfile'))) failures.push('Dockerfile is missing')
  if (!existsSync(join(ROOT, 'db', 'migrations', '20261119000000_baseline.sql'))) {
    failures.push('dbmate baseline migration is missing')
  }
  for (const [file, want] of [
    ['fly.toml', 'openlevel-staging'],
    ['fly.dev.toml', 'openlevel-dev'],
    ['fly.prod.toml', 'openlevel-prod'],
  ]) {
    const abs = join(ROOT, file)
    if (!existsSync(abs)) {
      failures.push(`${file} is missing (expected app ${want})`)
      continue
    }
    const body = readFileSync(abs, 'utf8')
    let doc = null
    try {
      doc = parseFlyConfig(body, file)
    } catch (err) {
      failures.push(`${file}: ${err instanceof Error ? err.message : String(err)}`)
      continue
    }
    if (doc.app !== want) failures.push(`${file} declares app "${doc.app}", expected "${want}"`)
    const envKeys = doc.env !== null && typeof doc.env === 'object' && !Array.isArray(doc.env) ? Object.keys(doc.env) : []
    for (const key of ['NODE_ENV', 'APP_ENV', 'ROLE', 'PORT']) {
      if (!envKeys.includes(key)) failures.push(`${file} [env] is missing ${key}`)
    }
    if (doc.deploy === null || typeof doc.deploy !== 'object' || typeof doc.deploy.release_command !== 'string' || doc.deploy.release_command === '') {
      failures.push(`${file} defines no release_command`)
    }
    // TOML assigns every key to the most recent table header, so top-level
    // kill_* keys must precede the FIRST [section] (caught twice by review:
    // once nesting in [[restart]], once in [env]).
    const firstSection = body.search(/^\s*\[+\s*[A-Za-z]/m)
    for (const key of ['kill_signal', 'kill_timeout']) {
      const at = body.search(new RegExp(`^${key}\\s*=`, 'm'))
      if (at === -1) failures.push(`${file} defines no top-level ${key}`)
      else if (firstSection !== -1 && at > firstSection) {
        failures.push(`${file}: ${key} sits inside a table section — move it next to app = ...`)
      }
    }
  }
  if (failures.length > 0) {
    for (const f of failures) console.error(`env validate: FAIL: ${f}`)
    process.exit(1)
  }
  console.log('env validate: OK — deployable surface is coherent (configs, image, migrations, runtime)')
}

function cmdEnv(name) {
  if (name === 'status') cmdEnvStatus()
  else if (name === 'validate') cmdEnvValidate()
  else fail(`unknown env view '${name}': use status or validate`, 2)
}

async function main() {
  const [sub, extra, jsonFlag] = [process.argv[2], process.argv[3], process.argv.includes('--json')]
  if (sub === 'detect') cmdDetect(jsonFlag || extra === '--json')
  else if (sub === 'versions') cmdVersions()
  else if (sub === 'gate') cmdGate()
  else if (sub === 'doctor') await cmdDoctor()
  else if (sub === 'plan') cmdPlan()
  else if (sub === 'install') cmdInstall()
  else if (sub === 'upgrade') cmdUpgrade()
  else if (sub === 'neon') {
    if (extra === undefined) fail("usage: toolchain.mjs neon <projects|branches|diff|inspect>", 2)
    cmdNeon(extra)
  } else if (sub === 'fly-guard') cmdFlyGuard()
  else if (sub === 'release-guard') cmdReleaseGuard()
  else if (sub === 'resolve-deployed-digest') cmdResolveDeployedDigest()
  else if (sub === 'env') {
    if (extra === undefined) fail('usage: toolchain.mjs env <status|validate>', 2)
    cmdEnv(extra)
  } else fail('usage: toolchain.mjs <detect|versions|gate|doctor|plan|install|upgrade|neon|fly-guard|release-guard|resolve-deployed-digest|env>', 2)
}

const invokedAsScript =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedAsScript) {
  main().catch((err) => fail(err?.message ?? String(err)))
}
