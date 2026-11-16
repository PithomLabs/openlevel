/**
 * Supervision tests (Prompt 33 P2-N1). Real short-lived children, no
 * sockets: prompt kill, exited no-op, SIGTERM-ignoring escalation, and an
 * isolated fatal harness proving concurrent faults share one shutdown.
 */
import { execFileSync, spawn } from 'node:child_process'
import { describe, expect, test } from 'vitest'
import { createSupervisor, killGroup, shutdown } from './proc.mjs'

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function sleeper(seconds = '30') {
  return spawn('sleep', [seconds], { detached: true, stdio: 'ignore' })
}

describe('shutdown', () => {
  test('terminates cooperative children promptly', async () => {
    const kids = [sleeper(), sleeper()]
    await shutdown(kids, { termMs: 5000, killMs: 1000 })
    expect(kids.every((k) => k.exitCode !== null || k.signalCode !== null)).toBe(true)
    expect(kids.every((k) => !isAlive(k.pid ?? -1))).toBe(true)
  })

  test('already-exited children are a fast no-op', async () => {
    const kid = spawn('sleep', ['0.01'], { detached: true, stdio: 'ignore' })
    await new Promise<void>((resolve) => kid.on('exit', () => resolve()))
    await expect(shutdown([kid], { termMs: 500, killMs: 200 })).resolves.toBeUndefined()
  })

  test('escalates to SIGKILL for TERM-ignoring children', async () => {
    const kid = spawn('sh', ['-c', 'trap "" TERM; while :; do sleep 1; done'], {
      detached: true,
      stdio: 'ignore',
    })
    const start = Date.now()
    await shutdown([kid], { termMs: 500, killMs: 5000 })
    expect(Date.now() - start).toBeLessThan(15000)
    expect(kid.exitCode !== null || kid.signalCode !== null).toBe(true)
    expect(isAlive(kid.pid ?? -1)).toBe(false)
  }, 20000)

  test('killGroup on an exited child never throws', async () => {
    const kid = spawn('sleep', ['0.01'], { detached: true, stdio: 'ignore' })
    await new Promise<void>((resolve) => kid.on('exit', () => resolve()))
    expect(() => killGroup(kid, 'SIGTERM')).not.toThrow()
  })
})

describe('createSupervisor', () => {
  test('concurrent stop calls share one shutdown run', async () => {
    const lines: string[] = []
    const sup = createSupervisor([sleeper()], { termMs: 2000, killMs: 1000, log: (m) => lines.push(m) })
    await Promise.all([sup.stop('first'), sup.stop('second'), sup.stop('third')])
    expect(sup.settled()).toBe(true)
    expect(lines.filter((l) => l === 'first')).toHaveLength(1)
    expect(lines.filter((l) => l === 'Both processes stopped.')).toHaveLength(1)
  })

  test('fatal harness: concurrent faults share one graceful shutdown, children die, exit is nonzero', () => {
    const lib = `${process.cwd()}/scripts/lib/proc.mjs`
    const harness = [
      "import { spawn } from 'node:child_process';",
      `import { createSupervisor } from '${lib}';`,
      "const kids = [0, 1].map(() => spawn('sh', ['-c', 'trap \"\" TERM; while :; do sleep 1; done'], { detached: true, stdio: 'ignore' }));",
      "console.log('PIDS:' + kids.map((k) => k.pid).join(','));",
      "const sup = createSupervisor(kids, { termMs: 3000, killMs: 2000, log: (m) => console.log('SUP:' + m) });",
      'sup.armFatalHandlers(3);',
      "setTimeout(() => { console.log('FAULT1'); throw new Error('boom-sync'); }, 100);",
      "setTimeout(() => { console.log('FAULT2'); Promise.reject(new Error('boom-async')); }, 150);",
    ].join('\n')
    let status: number | null = null
    let output = ''
    try {
      output = execFileSync(process.execPath, ['--input-type=module', '-e', harness], {
        encoding: 'utf8',
        timeout: 20000,
      })
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string }
      status = e.status ?? null
      output = `${e.stdout ?? ''}${e.stderr ?? ''}`
    }
    expect(status).toBe(3)
    const lines = output.split('\n')
    // Both faults fired; exactly one shutdown ran (reason once + done once).
    expect(lines).toContain('FAULT1')
    expect(lines).toContain('FAULT2')
    expect(lines.filter((l) => l.startsWith('SUP:'))).toHaveLength(2)
    expect(lines.filter((l) => l.includes('boom-'))).toHaveLength(1)
    // The second fault landed mid-shutdown (before the done marker).
    expect(lines.indexOf('FAULT2')).toBeLessThan(lines.lastIndexOf('SUP:Both processes stopped.'))
    // Every child is dead: no orphans, no survivors.
    const pids = (lines.find((l) => l.startsWith('PIDS:')) ?? '')
      .replace('PIDS:', '')
      .split(',')
      .map(Number)
    expect(pids).toHaveLength(2)
    expect(pids.every((pid) => !isAlive(pid))).toBe(true)
  }, 25000)
})
