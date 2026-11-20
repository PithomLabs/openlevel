/**
 * Smoke-runner entry (R14-05). Executes the probe inventory against one
 * target, emits a sanitized transcript (stdout + file), exits nonzero on
 * any FAIL. NOT RUN is honest, never silent: every skipped probe names its
 * reason.
 *
 * Env: SMOKE_TARGET (local|staging|preview), SMOKE_BASE_URL,
 * SMOKE_APP_ENV (expected), SMOKE_DATABASE_URL (local loopback SQL),
 * SMOKE_NEON_PROJECT (+ SMOKE_NEON_BRANCH), SMOKE_FLY_APP,
 * SMOKE_WEBHOOK_SECRET (runner-known synthetic), SMOKE_SINK_PHONE,
 * SMOKE_STAGING_NEON_PROJECT (preview compare), SMOKE_CONTAINER,
 * SMOKE_IMAGE, SMOKE_TRANSCRIPT (output path).
 */
import { writeFileSync } from 'node:fs'
import { PROBES, type SmokeTarget } from './inventory'
import { PROBE_RUNNERS, type ProbeOutcome, type SmokeConfig, type SmokeCtx } from './probes'
import { localSql, neonSql, sh, SmokeClient } from './client'
import { redact, scanCredentials } from './redact'

export interface RunHooks {
  logs: () => Promise<string>
  digest: () => Promise<string>
  stop?: () => Promise<{ exitCode: number; logs: string }>
}

function env(name: string, fallback = ''): string {
  return process.env[name] ?? fallback
}

export function configFromEnv(): SmokeConfig {
  const target = (env('SMOKE_TARGET', 'local') as SmokeTarget)
  if (target !== 'local' && target !== 'staging' && target !== 'preview') {
    throw new Error(`SMOKE_TARGET must be local|staging|preview, got ${target}`)
  }
  return {
    target,
    baseUrl: env('SMOKE_BASE_URL', 'http://127.0.0.1:8790'),
    appEnv: env('SMOKE_APP_ENV', target === 'preview' ? 'production' : 'staging'),
    sinkPhone: env('SMOKE_SINK_PHONE', '+15551230001'),
    webhookSecret: env('SMOKE_WEBHOOK_SECRET'),
    flyApp: env('SMOKE_FLY_APP'),
    neonProject: env('SMOKE_NEON_PROJECT'),
    stagingNeonProject: env('SMOKE_STAGING_NEON_PROJECT'),
    container: env('SMOKE_CONTAINER', 'openlevel-smoke-app'),
    image: env('SMOKE_IMAGE', 'openlevel:smoke'),
  }
}

async function sqlFromEnv(transcript: (l: string) => void, config: SmokeConfig) {
  if (config.target === 'local' && env('SMOKE_DATABASE_URL')) {
    return localSql(env('SMOKE_DATABASE_URL'))
  }
  if (config.target !== 'local' && config.neonProject) {
    return neonSql(transcript, config.neonProject, env('SMOKE_NEON_BRANCH') || undefined)
  }
  return null
}

export async function runSmoke(
  config: SmokeConfig,
  hooks: RunHooks,
  transcript: (line: string) => void,
  rawSink: (text: string) => void,
): Promise<{ results: Array<{ id: string; name: string; outcome: ProbeOutcome }>; failed: boolean }> {
  const started = new Date().toISOString()
  transcript(`smoke target=${config.target} base=${redact(config.baseUrl)} appEnv=${config.appEnv} started=${started}`)

  // Digest proof first: bind the whole run to the artifact under test.
  let digest = 'unknown'
  try {
    digest = await hooks.digest()
  } catch (err) {
    digest = `unavailable (${err instanceof Error ? err.message : 'error'})`
  }
  transcript(`artifact digest: ${redact(digest)}`)
  rawSink(digest)

  const sql = await sqlFromEnv(transcript, config)
  const client = new SmokeClient(config.baseUrl)
  const anon = new SmokeClient(config.baseUrl)
  const outcomes: string[] = []
  const state: Record<string, string> = {}
  let logCache = ''
  let logCacheAt = 0
  const logs = async (): Promise<string> => {
    if (Date.now() - logCacheAt > 5000) {
      logCache = await hooks.logs()
      logCacheAt = Date.now()
      rawSink(logCache)
    }
    return logCache
  }
  const ctx: SmokeCtx = {
    config,
    client,
    anon,
    sql,
    logs,
    noteOutcome: (o) => {
      outcomes.push(o)
      state.outcomesJson = JSON.stringify(outcomes)
    },
    state,
  }

  // Fixtures: one synthetic location + operator, identifiable by prefix.
  if (sql) {
    const stamp = Date.now().toString(36)
    const loc = `loc_smoke_${stamp}`
    const op = `op_smoke_${stamp}`
    const email = `smoke-${stamp}@example.com`
    const password = `smoke-pass-${stamp}`
    try {
      const { hashPassword } = await import('../../server/lib/password')
      await sql.query('INSERT INTO locations (id, name, slug) VALUES ($1,$2,$3)', [loc, `Smoke ${stamp}`, `smoke-${stamp}`])
      await sql.query('INSERT INTO operators (id, email, name, role, password_hash) VALUES ($1,$2,$3,$4,$5)', [
        op,
        email,
        'Smoke Op',
        'owner',
        await hashPassword(password),
      ])
      await sql.query('INSERT INTO operator_locations (operator_id, location_id) VALUES ($1,$2)', [op, loc])
      Object.assign(state, { loc, operatorId: op, email, password })
      transcript(`fixtures: location=${loc} operator=${email} (synthetic, cleaned by the cleanup probe)`)
    } catch (err) {
      transcript(`fixtures FAILED: ${redact(err instanceof Error ? err.message : String(err))} (auth-dependent probes will NOT RUN)`)
    }
  } else {
    transcript('fixtures: no SQL access — auth-dependent probes will NOT RUN')
  }

  const results: Array<{ id: string; name: string; outcome: ProbeOutcome }> = []
  // Execution order: HTTP probes first (inventory order), then stop (local),
  // then the aggregate/tail probes. The transcript notes the order.
  const httpIds = PROBES.map((p) => p.id).filter(
    (id) => !['sigterm', 'digest-proof', 'provider-non-invocation', 'no-staging-reuse', 'cleanup', 'credential-scan'].includes(id),
  )
  for (const id of httpIds) {
    const spec = PROBES.find((p) => p.id === id)
    if (!spec) continue
    if (!spec.targets.includes(config.target)) {
      results.push({ id, name: spec.name, outcome: { verdict: 'NOT RUN', detail: 'not applicable to this target' } })
      continue
    }
    try {
      const outcome = await PROBE_RUNNERS[id]!(ctx)
      results.push({ id, name: spec.name, outcome })
    } catch (err) {
      results.push({ id, name: spec.name, outcome: { verdict: 'FAIL', detail: `threw: ${redact(err instanceof Error ? err.message : String(err))}` } })
    }
  }

  // Local stop: the container goes down AFTER the last HTTP probe.
  let stopOutcome: ProbeOutcome | null = null
  if (hooks.stop) {
    try {
      const stopped = await hooks.stop()
      rawSink(stopped.logs)
      const graceful = stopped.logs.includes('shutdown: complete') && stopped.exitCode === 0
      stopOutcome = graceful
        ? { verdict: 'PASS', detail: `docker stop drained in order (exit ${stopped.exitCode}, shutdown: complete)` }
        : { verdict: 'FAIL', detail: `stop exit=${stopped.exitCode} complete=${stopped.logs.includes('shutdown: complete')}` }
    } catch (err) {
      stopOutcome = { verdict: 'FAIL', detail: `stop threw: ${redact(err instanceof Error ? err.message : String(err))}` }
    }
  }

  for (const id of ['sigterm', 'digest-proof', 'provider-non-invocation', 'no-staging-reuse', 'cleanup'] as const) {
    const spec = PROBES.find((p) => p.id === id)
    if (!spec) continue
    if (!spec.targets.includes(config.target)) {
      results.push({ id, name: spec.name, outcome: { verdict: 'NOT RUN', detail: 'not applicable to this target' } })
      continue
    }
    try {
      let outcome: ProbeOutcome
      if (id === 'sigterm' && stopOutcome) outcome = stopOutcome
      else if (id === 'digest-proof') {
        outcome = digest.startsWith('unavailable')
          ? { verdict: 'NOT RUN', detail: digest }
          : { verdict: 'PASS', detail: `running artifact: ${redact(digest)}` }
      } else outcome = await PROBE_RUNNERS[id]!(ctx)
      results.push({ id, name: spec.name, outcome })
    } catch (err) {
      results.push({ id, name: spec.name, outcome: { verdict: 'FAIL', detail: `threw: ${redact(err instanceof Error ? err.message : String(err))}` } })
    }
  }

  // The credential-scan probe runs in main() over everything captured
  // (raw, pre-redaction) after all other probes have reported.
  if (sql) await sql.close().catch(() => {})
  const failed = results.some((r) => r.outcome.verdict === 'FAIL')
  return { results, failed }
}

/** Shared tail: per-probe lines, credential scan, summary, file write. Returns exit code. */
export function finishTranscript(
  config: SmokeConfig,
  results: Array<{ id: string; name: string; outcome: ProbeOutcome }>,
  lines: string[],
  rawParts: string[],
): number {
  for (const r of results) {
    lines.push(`[${r.outcome.verdict}] ${r.id} — ${r.name} :: ${r.outcome.detail}`)
  }
  // Credential scan over raw captures + the transcript body itself.
  const scanHits = scanCredentials(`${rawParts.join('\n')}\n${lines.join('\n')}`)
  const leaked = scanHits.filter((h) => h.count > 0)
  lines.push(
    leaked.length === 0
      ? '[PASS] credential-scan — Zero credential patterns in captured logs + transcript :: all 7 patterns 0 matches'
      : `[FAIL] credential-scan — Zero credential patterns in captured logs + transcript :: ${leaked.map((h) => `${h.name}=${h.count}`).join(', ')} (counts only, values never printed)`,
  )
  const pass = results.filter((r) => r.outcome.verdict === 'PASS').length + (leaked.length === 0 ? 1 : 0)
  const failCount = results.filter((r) => r.outcome.verdict === 'FAIL').length + (leaked.length === 0 ? 0 : 1)
  const skipped = results.filter((r) => r.outcome.verdict === 'NOT RUN').length
  lines.push(`summary: target=${config.target} pass=${pass} fail=${failCount} not_run=${skipped} finished=${new Date().toISOString()}`)

  const out = `${lines.map(redact).join('\n')}\n`
  process.stdout.write(out)
  const path = env('SMOKE_TRANSCRIPT', `smoke-transcript-${config.target}.txt`)
  writeFileSync(path, out)
  return failCount > 0 ? 1 : 0
}

async function main(): Promise<void> {
  const config = configFromEnv()
  const lines: string[] = []
  const rawParts: string[] = []
  const transcript = (line: string): void => {
    lines.push(line)
  }
  const rawSink = (text: string): void => {
    rawParts.push(text)
  }
  const hooks: RunHooks = config.target === 'local'
    ? {
        logs: async () => {
          const { stdout, stderr } = await sh(transcript, 'docker', ['logs', config.container])
          return `${stdout}\n${stderr}`
        },
        digest: async () => {
          const { stdout } = await sh(transcript, 'docker', ['inspect', config.image, '--format', '{{.Id}}'])
          return stdout.trim()
        },
      }
    : {
        logs: async () => {
          if (!config.flyApp) throw new Error('SMOKE_FLY_APP required for remote log probes')
          // --no-tail: fetch the buffer once (bare `fly logs` streams forever).
          const { stdout } = await sh(transcript, 'fly', ['logs', '-a', config.flyApp, '--no-tail'])
          return stdout
        },
        digest: async () => {
          if (!config.flyApp) throw new Error('SMOKE_FLY_APP required for remote digest proof')
          try {
            const { stdout } = await sh(transcript, 'fly', ['image', 'show', '-a', config.flyApp, '--json'])
            const parsed = JSON.parse(stdout) as unknown
            const first = Array.isArray(parsed) ? parsed[0] : parsed
            const d = (first as { Digest?: string; digest?: string } | undefined)?.Digest ??
              (first as { digest?: string } | undefined)?.digest
            if (d) return d
          } catch {
            // fall through to text form
          }
          const { stdout } = await sh(transcript, 'fly', ['releases', '-a', config.flyApp, '--image'])
          const match = stdout.match(/sha256:[0-9a-f]{16,}/)
          if (match) return match[0]
          throw new Error(`no digest parsed from fly output: ${stdout.slice(0, 200)}`)
        },
      }

  const { results } = await runSmoke(config, hooks, transcript, rawSink)
  process.exitCode = finishTranscript(config, results, lines, rawParts)
}

// Run directly (`npx tsx scripts/smoke/run.ts`); import-safe for the local orchestrator.
const entry = process.argv[1]
if (entry) {
  const { pathToFileURL } = await import('node:url')
  if (import.meta.url === pathToFileURL(entry).href) {
    await main()
  }
}
