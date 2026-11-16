/**
 * Child-process supervision primitives (Prompt 33 P2-N1).
 * Import-safe (no side effects on import). `shutdown()` never rejects:
 * unexpected internal errors fall back to a synchronous SIGKILL sweep so
 * cleanup itself can never orphan children or mask the original failure.
 */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function exited(child) {
  return child.exitCode !== null || child.signalCode !== null
}

/** Signal the whole child process group, falling back to the child itself. Never throws. */
export function killGroup(child, signal) {
  if (!child || exited(child)) return
  try {
    process.kill(-child.pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      /* already gone */
    }
  }
}

function syncKillAll(children, signal) {
  for (const child of children) killGroup(child, signal)
}

export async function shutdown(children, { termMs = 10000, killMs = 5000, pollMs = 200 } = {}) {
  try {
    for (const child of children) killGroup(child, 'SIGTERM')
    const start = Date.now()
    while (Date.now() - start < termMs) {
      if (children.every(exited)) return
      await sleep(pollMs)
    }
    for (const child of children) killGroup(child, 'SIGKILL')
    const end = Date.now()
    while (Date.now() - end < killMs) {
      if (children.every(exited)) return
      await sleep(pollMs)
    }
  } catch {
    syncKillAll(children, 'SIGKILL')
  }
}

/**
 * One idempotent stop mechanism shared by every failure path. The graceful
 * sequence runs exactly once; concurrent callers await the same promise, so
 * `finally`, signals, and fatal handlers can never trigger conflicting
 * cleanup. The returned promise never rejects.
 */
export function createSupervisor(children, opts = {}) {
  const { termMs = 10000, killMs = 5000, log = console.log } = opts
  let current = null
  function stop(reason) {
    if (!current) {
      current = (async () => {
        try {
          if (reason) log(reason)
          await shutdown(children, { termMs, killMs })
          log('Both processes stopped.')
        } catch {
          syncKillAll(children, 'SIGKILL')
        }
      })()
    }
    return current
  }
  function settled() {
    return current !== null
  }
  /**
   * Route uncaught exceptions/rejections through the shared stop before
   * exiting nonzero — graceful first (bounded), never an immediate SIGKILL,
   * never a swallowed fault (the process always exits).
   */
  function armFatalHandlers(exitCode = 1) {
    const fatal = (err) => {
      const detail = err instanceof Error ? err.message : String(err)
      void stop(`Fatal error (${detail}) — stopping child processes...`).then(() => process.exit(exitCode))
    }
    process.on('uncaughtException', fatal)
    process.on('unhandledRejection', fatal)
  }
  return { stop, settled, armFatalHandlers }
}
