/**
 * Local smoke orchestrator (R14-05): builds the product image, boots
 * ephemeral PG 18.7 + the app container (APP_ENV=staging — the
 * safety-critical path), runs the probe inventory, stops the app (the
 * sigterm probe), and cleans up. Invoked via `task smoke`.
 *
 * Env: SMOKE_PORT (default 8791), SMOKE_PG_PORT (default 55433),
 * SMOKE_KEEP=1 (leave containers for debugging), plus the run.ts vars.
 */
import { sh } from './client'
import { configFromEnv, finishTranscript, runSmoke, type RunHooks } from './run'

const PG_IMAGE = 'postgres:18.7'
const PG_CONTAINER = 'openlevel-smoke-pg'
const PG_PASSWORD = 'smoke-local-pg'

async function main(): Promise<void> {
  const config = configFromEnv()
  if (config.target !== 'local') throw new Error('local orchestrator only runs SMOKE_TARGET=local')
  const lines: string[] = []
  const rawParts: string[] = []
  const transcript = (line: string): void => {
    lines.push(line)
  }
  const rawSink = (text: string): void => {
    rawParts.push(text)
  }
  const port = process.env.SMOKE_PORT ?? '8791'
  const pgPort = process.env.SMOKE_PG_PORT ?? '55433'
  const dbUrl = `postgres://postgres:${PG_PASSWORD}@127.0.0.1:${pgPort}/openlevel?sslmode=disable`
  process.env.SMOKE_DATABASE_URL = dbUrl

  let cleaned = false
  const cleanup = async (): Promise<void> => {
    if (cleaned) return
    cleaned = true
    if (process.env.SMOKE_KEEP === '1') {
      transcript('SMOKE_KEEP=1 — containers left running for debugging')
      return
    }
    await sh(transcript, 'docker', ['rm', '-f', config.container, PG_CONTAINER]).catch(() => {})
  }

  try {
    transcript('local setup: ephemeral PG 18.7 + product image build')
    await sh(transcript, 'docker', ['rm', '-f', config.container, PG_CONTAINER]).catch(() => {})
    await sh(transcript, 'docker', [
      'run',
      '--name',
      PG_CONTAINER,
      '-e',
      `POSTGRES_PASSWORD=${PG_PASSWORD}`,
      '-e',
      'POSTGRES_DB=openlevel',
      '-p',
      `${pgPort}:5432`,
      '-d',
      PG_IMAGE,
    ])
    await sh(transcript, 'docker', ['build', '-t', config.image, '.'], { timeoutMs: 600_000 })
    transcript('local setup: migrate (release-command equivalent)')
    await sh(transcript, 'docker', [
      'run',
      '--rm',
      '--network',
      'host',
      '-e',
      `DATABASE_URL=${dbUrl}`,
      config.image,
      'npm',
      'run',
      'db:migrate:release',
    ])
    transcript('local setup: boot app container (APP_ENV=staging)')
    const sessionSecret = `smoke-session-${Date.now().toString(36)}-pad-to-thirty-two-chars`
    const webhookSecret = `smoke-webhook-${Date.now().toString(36)}-pad-to-thirty-two`
    process.env.SMOKE_WEBHOOK_SECRET = webhookSecret
    config.webhookSecret = webhookSecret
    await sh(transcript, 'docker', [
      'run',
      '--network',
      'host',
      '-e',
      'NODE_ENV=production',
      '-e',
      'APP_ENV=staging',
      '-e',
      `DATABASE_URL=${dbUrl}`,
      '-e',
      `SESSION_SECRET=${sessionSecret}`,
      '-e',
      `CHATWOOT_WEBHOOK_SECRET=${webhookSecret}`,
      '-e',
      `PORT=${port}`,
      '-e',
      `STAGING_SINK_ALLOWLIST=${config.sinkPhone},smoke@example.com`,
      '--name',
      config.container,
      '-d',
      config.image,
    ])
    const base = `http://127.0.0.1:${port}`
    config.baseUrl = base
    const deadline = Date.now() + 90_000
    for (;;) {
      try {
        const res = await fetch(`${base}/ready`)
        if (res.ok) break
      } catch {
        // not up yet
      }
      if (Date.now() > deadline) throw new Error('app container never became ready')
      await new Promise((r) => setTimeout(r, 2000))
    }
    transcript('local setup: app ready')

    const hooks: RunHooks = {
      logs: async () => {
        const { stdout, stderr } = await sh(transcript, 'docker', ['logs', config.container])
        return `${stdout}\n${stderr}`
      },
      digest: async () => {
        const { stdout } = await sh(transcript, 'docker', ['inspect', config.image, '--format', '{{.Id}}'])
        return stdout.trim()
      },
      inspectEnv: async () => {
        const { stdout } = await sh(transcript, 'docker', [
          'inspect',
          config.container,
          '--format',
          '{{json .Config.Env}}',
        ])
        const pairs = JSON.parse(stdout) as string[]
        const env: Record<string, string> = {}
        for (const pair of pairs) {
          const eq = pair.indexOf('=')
          if (eq > 0) env[pair.slice(0, eq)] = pair.slice(eq + 1)
        }
        return env
      },
      stop: async () => {
        await sh(transcript, 'docker', ['stop', '-t', '25', config.container])
        const inspected = await sh(transcript, 'docker', ['inspect', config.container, '--format', '{{.State.ExitCode}}'])
        const stopped = await sh(transcript, 'docker', ['logs', config.container])
        return { exitCode: Number.parseInt(inspected.stdout.trim(), 10), logs: `${stopped.stdout}\n${stopped.stderr}` }
      },
    }
    const { results } = await runSmoke(config, hooks, transcript, rawSink)
    await cleanup()
    process.exitCode = finishTranscript(config, results, lines, rawParts)
  } catch (err) {
    const { redact } = await import('./redact')
    lines.push(`orchestrator FAILED: ${redact(err instanceof Error ? err.message : String(err))}`)
    await cleanup()
    finishTranscript(config, [], lines, rawParts)
    process.exitCode = 1
  } finally {
    await cleanup()
  }
}

const entry = process.argv[1]
if (entry) {
  const { pathToFileURL } = await import('node:url')
  if (import.meta.url === pathToFileURL(entry).href) {
    await main()
  }
}
