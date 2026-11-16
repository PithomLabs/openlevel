#!/usr/bin/env node
/**
 * OpenLevel local dev launcher (Prompt 29.2, spec Part II section 5).
 * Spawns the PGlite API backend + Vite frontend, waits for readiness,
 * opens the browser, forwards prefixed logs, and shuts both process
 * trees down cleanly. Node builtins only. macOS/Linux only.
 *
 *   node scripts/dev.mjs          full dev session (task dev)
 *   node scripts/dev.mjs health   readiness probe only (task dev:health)
 *   node scripts/dev.mjs open     open the UI in the browser (task dev:open)
 *
 * Env: OPENLEVEL_HOST (default 127.0.0.1), OPENLEVEL_API_PORT (8790),
 * OPENLEVEL_WEB_PORT (5273), DEV_READY_TIMEOUT_MS (90000), NO_BROWSER=1.
 */
import { execFile, spawn } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { get } from 'node:http'
import { createServer } from 'node:net'
import { platform } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { classifyBindError, describeBindFailure, endpointUrl, resolveDevConfig } from './lib/dev-env.mjs'
import { createSupervisor } from './lib/proc.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

function fail(message) {
  console.error(`dev: error: ${message}`)
  process.exit(1)
}

function assertPlatform() {
  if (platform() !== 'darwin' && platform() !== 'linux') {
    fail(`unsupported OS '${platform()}': task dev supports macOS and Linux only`)
  }
}

function intEnv(name, fallback, min, max) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number.parseInt(raw, 10)
  if (!Number.isInteger(value) || value < min || value > max) fail(`invalid ${name}=${raw}`)
  return value
}

// Single validated configuration source (Prompt 31). Fails fast here so no
// child starts with an invalid or silently-ignored config.
let CONFIG
try {
  CONFIG = resolveDevConfig(process.env)
} catch (err) {
  fail(err instanceof Error ? err.message : String(err))
}
const HOST = CONFIG.host
const API_PORT = CONFIG.apiPort
const WEB_PORT = CONFIG.webPort
// Explicit environment contract: children inherit the normalized values.
process.env.OPENLEVEL_HOST = HOST
process.env.OPENLEVEL_API_PORT = String(API_PORT)
process.env.OPENLEVEL_WEB_PORT = String(WEB_PORT)
const READY_TIMEOUT_MS = intEnv('DEV_READY_TIMEOUT_MS', 90000, 1000, 600000)
const API_URL = endpointUrl(HOST, API_PORT)
const WEB_URL = endpointUrl(HOST, WEB_PORT)
const HEALTH_URL = `${API_URL}/health`

async function checkRuntime() {
  const major = Number.parseInt(process.versions.node.split('.')[0], 10)
  if (!Number.isInteger(major) || major < 22) {
    fail(
      `node ${process.versions.node} is below the repository runtime (Node 22); ` +
        `select Node 22 in your version manager and retry`,
    )
  }
  try {
    await readdir(join(ROOT, 'node_modules'))
  } catch {
    fail('node_modules is missing; run `task deps:install` (npm ci) first')
  }
}

/** True on HTTP 2xx within the per-attempt budget. Never throws or rejects. */
function httpOk(url, attemptMs = 2000) {
  return new Promise((resolve) => {
    let req
    try {
      req = get(url, { timeout: attemptMs }, (res) => {
        res.resume()
        const code = res.statusCode ?? 0
        resolve(code >= 200 && code < 300)
      })
    } catch {
      resolve(false)
      return
    }
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', () => resolve(false))
  })
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function waitReady(url, timeoutMs) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await httpOk(url)) return true
    await sleep(500)
  }
  return false
}

/** Best-effort owner of a listening TCP port. Never throws. */
function portOwner(port) {
  return new Promise((resolve) => {
    const probe =
      platform() === 'darwin'
        ? { cmd: 'lsof', args: [`-iTCP:${port}`, '-sTCP:LISTEN', '-Pn'] }
        : { cmd: 'ss', args: ['-ltnp', `( sport = :${port} )`] }
    execFile(probe.cmd, probe.args, { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(null)
      const lines = stdout.trim().split('\n').filter(Boolean)
      if (lines.length === 0) return resolve(null)
      resolve(lines.length > 1 ? lines.slice(1).join('; ') : lines[0])
    })
  })
}

/** Fail unless HOST:port is free. Classification is shared (Prompt 31 P2-1). */
async function checkPortFree(label, port) {
  const failure = await new Promise((resolve) => {
    const server = createServer()
    server.once('error', (err) => resolve(classifyBindError(err)))
    server.listen(port, HOST, () => server.close(() => resolve(null)))
  })
  if (failure === null) return
  const base = { kind: failure.kind, code: failure.code, label, host: HOST, port }
  if (failure.kind === 'in-use') {
    const owner = await portOwner(port)
    fail(
      describeBindFailure({ ...base, owner }) +
        ' Stop the other process or free the port, then retry. ' +
        'This launcher never picks another port silently.',
    )
  }
  if (failure.kind === 'denied') {
    fail(
      describeBindFailure(base) + ' Sandboxed or restricted sessions cannot listen on sockets — run task dev on the host.',
    )
  }
  fail(`${describeBindFailure(base)} Check the address and retry.`)
}

function forwardPrefixed(child, tag) {
  for (const stream of ['stdout', 'stderr']) {
    let rest = ''
    child[stream].on('data', (chunk) => {
      const lines = (rest + chunk.toString()).split('\n')
      rest = lines.pop() ?? ''
      for (const line of lines) {
        if (line.length > 0) process[stream].write(`[${tag}] ${line}\n`)
      }
    })
    child.on('exit', () => {
      if (rest.length > 0) process[stream].write(`[${tag}] ${rest}\n`)
    })
  }
}

const SPAWNED = []
const supervisor = createSupervisor(SPAWNED, {})
const stop = (reason) => supervisor.stop(reason)

function spawnChild(tag, cmd, args) {
  const child = spawn(cmd, args, {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  })
  SPAWNED.push(child)
  child.on('error', (err) => {
    void stop(`cannot start ${tag} (${cmd} ${args.join(' ')}): ${err.message}`).then(() => process.exit(1))
  })
  forwardPrefixed(child, tag)
  return child
}

function openBrowser(url) {
  if (process.env.NO_BROWSER === '1') {
    console.log(`NO_BROWSER=1: skipping browser open (${url})`)
    return
  }
  const cmd = platform() === 'darwin' ? 'open' : 'xdg-open'
  execFile(cmd, [url], { timeout: 10000 }, (err) => {
    if (err) console.log(`Could not open a browser automatically (${cmd}: ${err.message}); visit ${url}`)
    else console.log(`Opened ${url} in your browser.`)
  })
}

async function cmdHealth() {
  const api = await httpOk(HEALTH_URL)
  const web = await httpOk(WEB_URL)
  console.log(`api ${HEALTH_URL} -> ${api ? 'OK' : 'DOWN'}`)
  console.log(`web ${WEB_URL} -> ${web ? 'OK' : 'DOWN'}`)
  process.exit(api && web ? 0 : 1)
}

async function cmdRun() {
  await checkRuntime()
  console.log('OpenLevel local development — starting API + UI (both loopback-only)')
  await checkPortFree('api', API_PORT)
  await checkPortFree('web', WEB_PORT)
  supervisor.armFatalHandlers(1)
  const api = spawnChild('api', 'npm', ['run', 'dev:local'])
  // Vite's bind (host/port/strictPort) comes from vite.config.ts, which reads
  // the same validated OPENLEVEL_* environment — no CLI templates, no drift.
  const web = spawnChild('web', 'npm', ['run', 'dev'])
  const pairs = [
    [api, 'api'],
    [web, 'web'],
  ]
  for (const [child, label] of pairs) {
    child.on('exit', (code, signal) => {
      if (supervisor.settled()) return
      void stop(`${label} exited unexpectedly (code=${code} signal=${signal}); stopping the other process.`).then(() =>
        process.exit(1),
      )
    })
  }
  process.on('SIGINT', () => {
    void stop('Interrupted — stopping both processes...').then(() => process.exit(0))
  })
  process.on('SIGTERM', () => {
    void stop('Terminated — stopping both processes...').then(() => process.exit(0))
  })
  let started = false
  try {
    console.log('Waiting for backend health + frontend readiness...')
    const [apiReady, webReady] = await Promise.all([
      waitReady(HEALTH_URL, READY_TIMEOUT_MS),
      waitReady(WEB_URL, READY_TIMEOUT_MS),
    ])
    if (!apiReady || !webReady) {
      await stop(
        `Readiness timed out (api=${apiReady ? 'ok' : 'TIMEOUT'} web=${webReady ? 'ok' : 'TIMEOUT'}). ` +
          `See the [api]/[web] logs above for the cause.`,
      )
      process.exit(1)
    }
    console.log('')
    console.log('OpenLevel local development')
    console.log(`API      ${API_URL}`)
    console.log(`UI       ${WEB_URL}`)
    console.log(`Health   ${HEALTH_URL}`)
    console.log('')
    console.log('Demo login')
    console.log('Email    admin@acmecorp.com')
    console.log('Password openlevel')
    console.log('')
    console.log('PGlite is in-memory; demo data resets when the API restarts.')
    console.log('Press Ctrl+C to stop both processes.')
    openBrowser(WEB_URL)
    started = true
  } finally {
    if (!started) await stop('Startup did not complete — stopping child processes...')
  }
}

async function main() {
  assertPlatform()
  const mode = process.argv[2] ?? 'run'
  if (mode === 'run') await cmdRun()
  else if (mode === 'health') await cmdHealth()
  else if (mode === 'open') openBrowser(WEB_URL)
  else fail(`unknown mode '${mode}': use run (default), health, or open`)
}

main().catch((err) => fail(err?.message ?? String(err)))
