import { EventEmitter } from 'node:events'
import {
  SHUTDOWN_DEADLINE_MS,
  attachBossErrorHandler,
  attachPoolErrorHandler,
  attachProcessErrorHandlers,
  createReadiness,
  createShutdown,
  parseRole,
  withDeadline,
} from './lifecycle'

test('parseRole defaults to all and accepts web|worker|all', () => {
  expect(parseRole(undefined)).toBe('all')
  expect(parseRole('')).toBe('all')
  expect(parseRole('web')).toBe('web')
  expect(parseRole('worker')).toBe('worker')
  expect(parseRole('all')).toBe('all')
})

test('parseRole rejects unknown roles (fail closed)', () => {
  expect(() => parseRole('BOSS')).toThrow(/ROLE must be web\|worker\|all/)
  expect(() => parseRole('web,worker')).toThrow(/ROLE must be/)
})

test('readiness starts not-ready, flips ready, flips back with a reason', () => {
  const r = createReadiness()
  expect(r.snapshot()).toEqual({ ready: false, reason: 'starting' })
  r.markReady()
  expect(r.snapshot()).toEqual({ ready: true })
  r.markNotReady('shutting-down')
  expect(r.snapshot()).toEqual({ ready: false, reason: 'shutting-down' })
})

test('shutdown runs server -> boss -> pool in order and marks not-ready first', async () => {
  const order: string[] = []
  const shutdown = createShutdown({
    server: {
      close: (cb) => {
        order.push('server.close')
        cb()
      },
    },
    boss: {
      stop: async () => {
        order.push('boss.stop')
      },
    },
    pool: {
      end: async () => {
        order.push('pool.end')
      },
    },
    readiness: { markNotReady: () => void order.push('not-ready') },
    httpGraceMs: 10,
  })
  await shutdown()
  expect(order).toEqual(['not-ready', 'server.close', 'boss.stop', 'pool.end'])
})

test('shutdown skips absent subsystems (web has no boss, worker has no server)', async () => {
  const order: string[] = []
  const webOnly = createShutdown({
    server: { close: (cb) => void (order.push('server.close'), cb()) },
    pool: { end: async () => void order.push('pool.end') },
    readiness: { markNotReady: () => void order.push('not-ready') },
    httpGraceMs: 10,
  })
  await webOnly()
  expect(order).toEqual(['not-ready', 'server.close', 'pool.end'])

  order.length = 0
  const workerOnly = createShutdown({
    boss: { stop: async () => void order.push('boss.stop') },
    pool: { end: async () => void order.push('pool.end') },
    readiness: { markNotReady: () => void order.push('not-ready') },
  })
  await workerOnly()
  expect(order).toEqual(['not-ready', 'boss.stop', 'pool.end'])
})

test('shutdown forces connections when HTTP close overruns its grace', async () => {
  const order: string[] = []
  let closed = false
  const shutdown = createShutdown({
    server: {
      // A server held open by a long request: close() only fires after force.
      close: (cb) => {
        const poll = () => (closed ? cb() : setTimeout(poll, 5))
        poll()
      },
      closeAllConnections: () => {
        order.push('force')
        closed = true
      },
    },
    pool: { end: async () => void order.push('pool.end') },
    readiness: { markNotReady: () => {} },
    httpGraceMs: 20,
  })
  await shutdown()
  expect(order).toEqual(['force', 'pool.end'])
})

test('shutdown passes the boss drain bound through to boss.stop', async () => {
  let seen: { timeout?: number } | undefined
  const shutdown = createShutdown({
    boss: {
      stop: async (opts) => {
        seen = opts
      },
    },
    pool: { end: async () => {} },
    readiness: { markNotReady: () => {} },
    bossTimeoutMs: 1234,
  })
  await shutdown()
  expect(seen).toEqual({ timeout: 1234 })
})

test('shutdown runs every stage even when one fails, then reports incomplete (Review 11 P2)', async () => {
  const order: string[] = []
  const logs: string[] = []
  const shutdown = createShutdown({
    server: {
      close: (cb) => {
        order.push('server.close')
        cb()
      },
    },
    boss: {
      stop: async () => {
        order.push('boss.stop')
        throw new Error('drain exploded')
      },
    },
    pool: {
      end: async () => {
        order.push('pool.end')
      },
    },
    readiness: { markNotReady: () => void order.push('not-ready') },
    log: (msg) => void logs.push(msg),
    httpGraceMs: 10,
  })
  await expect(shutdown()).rejects.toThrow(/shutdown incomplete: pg-boss drain failed/)
  expect(order).toEqual(['not-ready', 'server.close', 'boss.stop', 'pool.end'])
  expect(logs.join('\n')).toMatch(/pg-boss drain failed/)
})

test('double shutdown runs the sequence once (double SIGTERM safe)', async () => {
  let closes = 0
  const shutdown = createShutdown({
    server: {
      close: (cb) => {
        closes += 1
        cb()
      },
    },
    pool: { end: async () => {} },
    readiness: { markNotReady: () => {} },
    httpGraceMs: 10,
  })
  await Promise.all([shutdown(), shutdown(), shutdown()])
  expect(closes).toBe(1)
})

test('withDeadline reports true when shutdown finishes in time', async () => {
  await expect(withDeadline(async () => {}, 50)).resolves.toBe(true)
})

test('withDeadline reports false when the deadline wins', async () => {
  await expect(withDeadline(() => new Promise<void>(() => {}), 20)).resolves.toBe(false)
})

test('shutdown deadline fits inside the Fly kill_timeout with margin', () => {
  // fly.toml sets kill_timeout = 30s; the app must be gone well before SIGKILL.
  expect(SHUTDOWN_DEADLINE_MS).toBeLessThanOrEqual(25_000)
})

test('pool idle errors report through the boundary with source tag (FIND-01)', () => {
  const seen: [string, unknown][] = []
  const pool = new EventEmitter()
  attachPoolErrorHandler(pool as unknown as Parameters<typeof attachPoolErrorHandler>[0], (s, e) =>
    seen.push([s, e]),
  )
  const err = new Error('terminating connection')
  pool.emit('error', err)
  expect(seen).toEqual([['pg-pool-idle', err]])
})

test('boss errors report through the boundary with source tag (FIND-01)', () => {
  const seen: [string, unknown][] = []
  const boss = new EventEmitter()
  attachBossErrorHandler(boss as unknown as Parameters<typeof attachBossErrorHandler>[0], (s, e) =>
    seen.push([s, e]),
  )
  const err = new Error('maintenance failed')
  boss.emit('error', err)
  expect(seen).toEqual([['pg-boss', err]])
})

test('process fatals report scrubbed and exit 1, then detach cleanly (FIND-01)', () => {
  const seen: [string, unknown][] = []
  const exits: number[] = []
  const beforeUncaught = process.listenerCount('uncaughtException')
  const beforeUnhandled = process.listenerCount('unhandledRejection')
  const detach = attachProcessErrorHandlers(
    (s, e) => seen.push([s, e]),
    (code) => exits.push(code),
  )
  try {
    // Invoke only our attached listeners (never process.emit: that would
    // also fire the test runner's own fatal handlers).
    const uncaught = process.listeners('uncaughtException').at(-1) as (e: unknown) => void
    const unhandled = process.listeners('unhandledRejection').at(-1) as (r: unknown) => void
    uncaught(new Error('boom-uncaught'))
    unhandled('boom-unhandled')
    expect(seen.map(([s]) => s)).toEqual(['uncaught-exception', 'unhandled-rejection'])
    expect(exits).toEqual([1, 1])
  } finally {
    detach()
  }
  expect(process.listenerCount('uncaughtException')).toBe(beforeUncaught)
  expect(process.listenerCount('unhandledRejection')).toBe(beforeUnhandled)
})
