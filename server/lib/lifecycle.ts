/**
 * Process lifecycle: roles, readiness, and ordered SIGTERM shutdown.
 *
 * Roles (ROLE env, default 'all'):
 *   - web:    HTTP + boss send-only (no consumers). A web Machine enqueues
 *             but never consumes jobs.
 *   - worker: pg-boss consumers only (no HTTP listener). A worker Machine
 *             exposes no port, so it carries no http_service checks; its check
 *             story is the [[restart]] policy (a crash/OOM/failed boot exits
 *             nonzero and restarts with backoff, then stays down visibly) plus
 *             DLQ depth / job-age alerting on the queues it consumes. Not yet
 *             split out: every fly config still runs ROLE=all.
 *   - all:    combined process (HTTP + consumers). The initial single-Machine
 *             staging topology; the ONLY role staging runs.
 *
 * Shutdown order (bounded, fits inside Fly kill_timeout):
 *   1. mark not-ready so /ready flips to 503 and the router drains us,
 *   2. stop accepting HTTP (close, then force idle/held connections),
 *   3. drain pg-boss workers via the verified boss.stop({timeout}) API,
 *   4. close the application database pools.
 */

import { collectEnvSecrets, formatSafeError } from './secrets'

/** Process roles. Unknown values are rejected at boot (fail closed). */
export type Role = 'web' | 'worker' | 'all'

export function parseRole(raw: string | undefined): Role {
  if (raw === undefined || raw === '') return 'all'
  if (raw === 'web' || raw === 'worker' || raw === 'all') return raw
  throw new Error(`ROLE must be web|worker|all, got ${JSON.stringify(raw)}`)
}

/** Readiness reasons. Short enums only — never credentials, URLs, or stacks.
 *  No boss reason: pg-boss exposes no continuous health API, so boss
 *  readiness is proven by boot ordering (markReady runs only after the
 *  workers register) rather than a faked per-check signal. */
export type NotReadyReason = 'starting' | 'shutting-down' | 'db' | 'db-timeout'

export type Readiness = { ready: true } | { ready: false; reason: NotReadyReason }

/**
 * Mutable readiness cell. Bootstrap flips it ready once every required
 * subsystem for the role is up, and back to shutting-down on SIGTERM.
 * The /ready probe combines this cell with a live DB ping.
 */
export function createReadiness() {
  let state: Readiness = { ready: false, reason: 'starting' }
  return {
    snapshot(): Readiness {
      return state
    },
    markReady(): void {
      state = { ready: true }
    },
    markNotReady(reason: NotReadyReason): void {
      state = { ready: false, reason }
    },
  }
}

export type ReadinessCell = ReturnType<typeof createReadiness>

/** Minimal closables — structural so tests can use fakes. */
export interface StoppableHttp {
  close(cb: (err?: Error) => void): void
  closeIdleConnections?(): void
  closeAllConnections?(): void
}

export interface StoppableBoss {
  stop(options?: { timeout?: number }): Promise<void>
}

export interface StoppablePool {
  end(): Promise<void>
}

export interface ShutdownDeps {
  /** Absent in the worker role (no listener there). */
  server?: StoppableHttp
  /** Always present from bootstrap today; optional so a future send-free
   *  role can shut down without a boss instance. */
  boss?: StoppableBoss
  pool: StoppablePool
  readiness: Pick<ReadinessCell, 'markNotReady'>
  /** Milliseconds to wait for HTTP close before forcing connections. */
  httpGraceMs?: number
  /** pg-boss drain bound. Must keep total shutdown under kill_timeout. */
  bossTimeoutMs?: number
  log?: (msg: string) => void
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Build the one-shot ordered shutdown. The first invocation runs the
 * sequence; concurrent/late invocations (double SIGTERM) await the same
 * run instead of closing things twice.
 */
export function createShutdown(deps: ShutdownDeps): () => Promise<void> {
  const httpGraceMs = deps.httpGraceMs ?? 5000
  const bossTimeoutMs = deps.bossTimeoutMs ?? 15000
  const log = deps.log ?? (() => {})
  let run: Promise<void> | null = null

  return () => {
    run ??= (async () => {
      deps.readiness.markNotReady('shutting-down')
      // Every stage runs even when an earlier one fails (Review 11 P2): a
      // throwing boss.stop must not strand open pools, and a broken listener
      // must not skip the worker drain. Stage failures are logged scrubbed
      // and rethrown as one incomplete-shutdown error at the end (exit 1).
      const secrets = collectEnvSecrets(process.env)
      const failures: string[] = []
      const attempt = async (stage: string, fn: () => Promise<void>): Promise<void> => {
        try {
          await fn()
        } catch (err) {
          failures.push(stage)
          log(`shutdown: ${stage} failed: ${formatSafeError(err, secrets)}`)
        }
      }

      if (deps.server) {
        const server = deps.server
        await attempt('HTTP listener', async () => {
          log('shutdown: closing HTTP listener')
          // Idle keep-alive connections would hold close() open past our
          // budget; drop them first, then give in-flight requests httpGraceMs.
          server.closeIdleConnections?.()
          let force: ReturnType<typeof setTimeout> | null = setTimeout(() => {
            force = null
            log('shutdown: HTTP grace expired, forcing connections closed')
            server.closeAllConnections?.()
          }, httpGraceMs)
          // close() waits for connections; unref the force timer so a fast
          // close resolves without waiting out the grace period.
          force.unref?.()
          await new Promise<void>((resolve) => {
            server.close(() => {
              if (force !== null) {
                clearTimeout(force)
                force = null
              }
              resolve()
            })
          })
          log('shutdown: HTTP closed')
        })
      }

      if (deps.boss) {
        const boss = deps.boss
        await attempt('pg-boss drain', async () => {
          log('shutdown: draining pg-boss')
          // Verified pg-boss 12 API: graceful drain bounded by timeout, then
          // fail-WIP + close. Never invents lifecycle methods.
          await boss.stop({ timeout: bossTimeoutMs })
          log('shutdown: pg-boss stopped')
        })
      }

      await attempt('database pools', async () => {
        log('shutdown: closing database pools')
        await deps.pool.end()
        log('shutdown: complete')
      })

      if (failures.length > 0) {
        throw new Error(`shutdown incomplete: ${failures.join(', ')} failed`)
      }
    })()
    return run
  }
}

/**
 * Race a shutdown against a hard wall-clock deadline. Resolves true when
 * the shutdown finished in time, false when the deadline won (caller exits
 * nonzero — Fly SIGKILLs at kill_timeout regardless).
 */
export async function withDeadline(shutdown: () => Promise<void>, deadlineMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    const result = await Promise.race([
      shutdown().then((): boolean => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), deadlineMs)
      }),
    ])
    return result
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

/** Total shutdown budget: comfortably inside Fly kill_timeout (30s). */
export const SHUTDOWN_DEADLINE_MS = 25_000

/**
 * Error-emitter wiring (FIND-01). Idle pg clients and boss maintenance can
 * fail without failing a request; without handlers those errors either crash
 * the process raw (pool) or vanish (boss). Both report through the central
 * boundary and let the subsystem self-heal — the pool drops the broken
 * client, boss keeps polling — while `/ready`'s live ping 503s if the
 * database is truly down. A reporter is injectable so tests can capture.
 */
export type ErrorReporter = (source: string, err: unknown) => void

export function attachPoolErrorHandler(
  pool: { on(event: 'error', fn: (err: unknown) => void): void },
  report: ErrorReporter,
): void {
  pool.on('error', (err) => report('pg-pool-idle', err))
}

export function attachBossErrorHandler(
  boss: { on(event: 'error', fn: (err: unknown) => void): void },
  report: ErrorReporter,
): void {
  boss.on('error', (err) => report('pg-boss', err))
}

/**
 * Fatal process handlers. An uncaught exception or unhandled rejection is
 * unrecoverable by definition: report scrubbed, then exit(1) — never log
 * raw, never swallow and keep serving. Returns a detach function so tests
 * can clean up the test-worker's own process listeners. `exit` is
 * injectable for the same reason; production passes the real thing.
 */
export function attachProcessErrorHandlers(
  report: ErrorReporter,
  exit: (code: number) => void = (code) => process.exit(code),
): () => void {
  const onUncaught = (err: unknown) => {
    report('uncaught-exception', err)
    exit(1)
  }
  const onUnhandled = (reason: unknown) => {
    report('unhandled-rejection', reason)
    exit(1)
  }
  process.on('uncaughtException', onUncaught)
  process.on('unhandledRejection', onUnhandled)
  return () => {
    process.removeListener('uncaughtException', onUncaught)
    process.removeListener('unhandledRejection', onUnhandled)
  }
}
