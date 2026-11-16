#!/usr/bin/env node
/**
 * OpenLevel toolchain helper (Prompt 29.2, spec Part II sections 2-4, 8-9).
 * Host detection, compatible-version planning, environment doctor, guided
 * installs, and read-only cloud-CLI guards. Node builtins only.
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
 *   node scripts/toolchain.mjs fly-guard  (needs FLY_APP, FLY_CONFIG, CONFIRM_DEPLOY=yes)
 */
import { execFileSync, execSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { arch as osArch, homedir, platform } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
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
    push('node', 'FAIL', 'not found — install Node 22 per `task tools:plan`, then retry')
  } else {
    const major = nodeMajor(node.version)
    if (major === null || major < 22) push('node', 'FAIL', `${node.version} is below engines >=22 — select Node 22`)
    else if (major !== 22) push('node', 'WARN', `${node.version}: repo + CI standardize on Node 22 — switch for this repo`)
    else push('node', 'OK', `${node.version} [${node.path}]`)
  }
  const npm = toolVersion('npm', '--version')
  push('npm', npm.path === null ? 'FAIL' : 'OK', npm.path === null ? 'not found (ships with Node)' : `${npm.version} [${npm.path}]`)
  push('node_modules', existsSync(join(ROOT, 'node_modules')) ? 'OK' : 'FAIL', existsSync(join(ROOT, 'node_modules')) ? 'present' : 'missing — run `task deps:install`')
  push('.nvmrc', existsSync(join(ROOT, '.nvmrc')) ? 'OK' : 'WARN', existsSync(join(ROOT, '.nvmrc')) ? 'pins Node 22' : 'missing — project Node pin not found')
  const task = toolVersion('task', '--version')
  push('task', task.path === null ? 'WARN' : 'OK', task.path === null ? 'not found — install per `task tools:plan`' : `${task.version} [${task.path}]`)
  const psql = toolVersion('psql', '--version')
  push('psql', 'INFO', psql.path === null ? 'not found (optional; needed only for native-PostgreSQL db:* tasks)' : `${psql.version} [${psql.path}]`)
  const fly = toolVersion('fly', 'version')
  push('fly', 'INFO', fly.path === null ? 'not found (optional; needed only for fly:* tasks)' : `${fly.version} [${fly.path}]`)
  const neon = toolVersion('neon', '--version')
  push('neon', 'INFO', neon.path === null ? 'not found (optional; needed only for neon:* tasks)' : `${neon.version} [${neon.path}]`)
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
  console.log('[node-22] REQUIRED — project runtime (engines >=22, CI pins 22).')
  console.log('  route: latest Node 22.x patch via the existing manager, else fnm (official darwin/linux assets).')
  console.log('  compat: macOS 11+ floor covers Monterey 12 (x64/arm64); Linux Tier 1 needs glibc >=2.28.')
  console.log('  pin: .nvmrc selects 22; fresh shells must resolve Node 22 inside this repo.')
  console.log('  verify: node --version  →  v22.x')
  console.log('  sources: https://nodejs.org/en/about/previous-releases')
  console.log('           https://github.com/nodejs/node/blob/v22.x/BUILDING.md')
  console.log('')
  const dm = info.os === 'darwin' ? darwinMajor(info.osVersion) : null
  if (dm !== null && dm < 13) {
    console.log('[node-latest] SKIP_OPTIONAL on this host — Active LTS binaries need macOS 13.5+; Monterey stays on Node 22.')
  } else {
    console.log('[node-latest] OPTIONAL — newest Active LTS alongside 22 only where the host floor allows; never the repo runtime.')
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
  console.log('[neon] latest stable `neon` CLI (npm package needs Node >=20.19 — Node 22 satisfies it).')
  console.log('  route: npm install --global neon@latest under Node 22; else the exact OS/arch standalone binary with integrity check.')
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
  if (node.path !== null && major === 22) {
    console.log(`[node-22] ALREADY_COMPATIBLE ${node.version}`)
  } else {
    pending.push('[node-22] owner action: install the latest Node 22.x patch (see `task tools:plan`), then re-run')
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
  } else if (node.path !== null && major !== null && major >= 22) {
    console.log('[neon] attempting per-user install: npm install --global neon@latest')
    const res = spawnSync('npm', ['install', '--global', 'neon@latest'], { encoding: 'utf8', timeout: 120000 })
    if (res.status === 0 && which('neon') !== null) console.log('[neon] INSTALLED')
    else pending.push('[neon] owner action: `npm install --global neon@latest` under Node 22 failed here — run it, or use the standalone binary')
  } else {
    pending.push('[neon] owner action: install Node 22 first, then `npm install --global neon@latest`')
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
    console.log('Node major changes are NEVER applied automatically — the repo stays on Node 22.')
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
  diff: { group: 'branches', op: 'diff', needId: true },
}

function neonExec(group, op, needId) {
  if (which('neon') === null) fail('neon CLI not installed — see `task tools:plan`')
  const id = process.env.PROJECT_ID ?? ''
  if (needId && id === '') fail('PROJECT_ID is required: e.g. task neon:branches PROJECT_ID=<id>')
  const top = capture('neon', ['--help'])
  if (top === null || !top.includes(group)) fail(`installed neon CLI has no '${group}' group — see \`neon --help\``)
  const groupHelp = capture('neon', [group, '--help'])
  if (groupHelp === null || !groupHelp.includes(op)) {
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

/** Six-condition guard for the future-only fly:deploy task. Fails closed. */
function cmdFlyGuard() {
  const app = process.env.FLY_APP ?? ''
  const config = process.env.FLY_CONFIG ?? ''
  const confirm = process.env.CONFIRM_DEPLOY ?? ''
  if (app === '') fail('FLY_APP is required: task fly:deploy FLY_APP=<app> FLY_CONFIG=<path> CONFIRM_DEPLOY=yes', 2)
  if (config === '') fail('FLY_CONFIG is required: task fly:deploy FLY_APP=<app> FLY_CONFIG=<path> CONFIRM_DEPLOY=yes', 2)
  const abs = resolve(ROOT, config)
  const p2 = resolve(ROOT, join('phase0', 'p2', 'fly.staging.toml'))
  if (abs === p2) fail('refusing: phase0/p2/fly.staging.toml is the isolated P2 proof, never a product deploy target', 2)
  let body = null
  try {
    body = readFileSync(abs, 'utf8')
  } catch {
    fail(`FLY_CONFIG is not readable: ${config}`, 2)
  }
  if (body.includes('openlevel-p2-staging')) fail('refusing: that config declares the P2 staging app, not a product app', 2)
  if (confirm !== 'yes') fail('refusing: set CONFIRM_DEPLOY=yes — owner authorization is required for any deploy', 2)
  console.log(`fly deploy guard passed (app + config validated; no secrets shown)`)
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
  else fail('usage: toolchain.mjs <detect|versions|gate|doctor|plan|install|upgrade|neon|fly-guard>', 2)
}

main().catch((err) => fail(err?.message ?? String(err)))
