/** Types for ./proc.mjs (kept for the scripts type gate). */
import type { ChildProcess } from 'node:child_process'

export interface ShutdownOpts {
  termMs?: number
  killMs?: number
  pollMs?: number
}
export declare function killGroup(child: ChildProcess, signal: NodeJS.Signals): void
export declare function shutdown(children: ChildProcess[], opts?: ShutdownOpts): Promise<void>
export interface SupervisorOpts extends ShutdownOpts {
  log?: (message: string) => void
}
export interface Supervisor {
  stop: (reason?: string) => Promise<void>
  settled: () => boolean
  armFatalHandlers: (exitCode?: number) => void
}
export declare function createSupervisor(children: ChildProcess[], opts?: SupervisorOpts): Supervisor
