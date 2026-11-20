// Local dev secrets resolve from the OS credential store — never from files.
// No custom vault: macOS Keychain and Linux libsecret already do the job.
//
//   node scripts/lib/secret-store.mjs status        # FOUND/MISSING per name (values never printed)
//   node scripts/lib/secret-store.mjs exec -- <cmd> # resolve + exec <cmd> with secrets injected
//
// Basic `task dev` needs NO secrets (PGlite + dev defaults + stubbed
// providers). This exists for the day a developer needs a REAL dev-only
// provider key: store it once (`secret-tool store --label=openlevel-dev
// openlevel <NAME>` / Keychain Access), then run through `exec`.
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export const SERVICE = 'openlevel'

/** Must equal server/lib/secrets.ts SECRET_ENV_VARS (pinned by scripts/secret-store.test.ts). */
export const KNOWN_SECRET_NAMES = [
  'DATABASE_URL',
  'SESSION_SECRET',
  'CHATWOOT_WEBHOOK_SECRET',
  'FEDERATION_SERVICE_TOKEN',
  'INTERNAL_PUSH_SECRET',
]

export function backendFor(platform = process.platform) {
  if (platform === 'darwin') return 'keychain'
  if (platform === 'linux') return 'libsecret'
  return 'unsupported'
}

/** argv to fetch a secret's value (stdout-captured in-process, never logged). */
export function getArgv(backend, name) {
  if (backend === 'keychain') return ['security', ['find-generic-password', '-s', `${SERVICE}-${name}`, '-w']]
  if (backend === 'libsecret') return ['secret-tool', ['lookup', SERVICE, name]]
  throw new Error(`no secret backend on this platform (need macOS Keychain or Linux libsecret)`)
}

function run(argv0, args, timeoutMs = 10000) {
  return spawnSync(argv0, args, { encoding: 'utf8', timeout: timeoutMs })
}

/**
 * Resolve one secret. Returns the value, or undefined when the backend is
 * missing, the item is absent, or anything fails. Never prints the value.
 */
export function getSecret(name, deps = {}) {
  const platform = deps.platform ?? process.platform
  const backend = backendFor(platform)
  if (backend === 'unsupported') return undefined
  try {
    const [argv0, args] = (deps.getArgv ?? getArgv)(backend, name)
    const res = (deps.run ?? run)(argv0, args)
    if (res.status !== 0 || typeof res.stdout !== 'string') return undefined
    const value = res.stdout.replace(/\n$/, '')
    return value === '' ? undefined : value
  } catch {
    return undefined
  }
}

/** Resolve every known name; returns only the ones the store actually holds. */
export function resolveAll(deps = {}) {
  const names = deps.names ?? KNOWN_SECRET_NAMES
  const found = {}
  for (const name of names) {
    const value = (deps.getSecret ?? getSecret)(name, deps)
    if (value !== undefined) found[name] = value
  }
  return found
}

function cmdStatus() {
  const backend = backendFor()
  console.log(`secret store: backend=${backend}`)
  if (backend === 'unsupported') {
    console.log('no OS credential store on this platform — dev defaults + stubbed providers still work')
    return
  }
  for (const name of KNOWN_SECRET_NAMES) {
    // Presence only. Values stay in the store / child env, never on screen.
    console.log(`${name}: ${getSecret(name) === undefined ? 'MISSING' : 'FOUND'}`)
  }
}

export function cmdExec(childArgv, deps = {}) {
  if (childArgv.length === 0) {
    console.error('usage: secret-store.mjs exec -- <command> [args...]')
    process.exitCode = 2
    return
  }
  const secrets = (deps.resolveAll ?? resolveAll)(deps)
  const names = Object.keys(secrets)
  console.log(`secret store: injecting ${names.length} secret(s) (${names.join(', ') || 'none'}) into child env`)
  const res = (deps.spawn ?? spawnSync)(childArgv[0], childArgv.slice(1), {
    env: { ...process.env, ...secrets },
    stdio: 'inherit',
  })
  process.exitCode = typeof res.status === 'number' ? res.status : 1
}

const invokedAsScript =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedAsScript) {
  const [, , sub, ...rest] = process.argv
  if (sub === 'status') cmdStatus()
  else if (sub === 'exec') cmdExec(rest[0] === '--' ? rest.slice(1) : rest)
  else {
    console.error('usage: secret-store.mjs <status|exec -- <command> [args...]>')
    process.exitCode = 2
  }
}
