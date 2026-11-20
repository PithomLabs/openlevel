// Types for the untyped ESM helper (keeps typecheck:scripts strict without
// converting the runtime file to TypeScript).
export const SERVICE: string
export const KNOWN_SECRET_NAMES: string[]
export function backendFor(platform?: string): 'keychain' | 'libsecret' | 'unsupported'
export function getArgv(backend: string, name: string): [string, string[]]
export type RunFn = (argv0: string, args: string[]) => { status: number | null; stdout: unknown }
export interface GetSecretDeps {
  platform?: string
  getArgv?: (backend: string, name: string) => [string, string[]]
  run?: RunFn
}
export function getSecret(name: string, deps?: GetSecretDeps): string | undefined
export interface ResolveAllDeps extends GetSecretDeps {
  names?: string[]
  getSecret?: (name: string, deps?: GetSecretDeps) => string | undefined
}
export function resolveAll(deps?: ResolveAllDeps): Record<string, string>
export interface CmdExecDeps extends ResolveAllDeps {
  resolveAll?: (deps?: ResolveAllDeps) => Record<string, string>
  spawn?: (cmd: string, args: string[], opts: object) => { status: number | null }
}
export function cmdExec(childArgv: string[], deps?: CmdExecDeps): void
