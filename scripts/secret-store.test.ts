import { vi } from 'vitest'
import { SECRET_ENV_VARS } from '../server/lib/secrets'
import {
  type CmdExecDeps,
  KNOWN_SECRET_NAMES,
  backendFor,
  cmdExec,
  getArgv,
  getSecret,
  resolveAll,
} from './lib/secret-store.mjs'

test('script secret names match the canonical server list', () => {
  expect([...KNOWN_SECRET_NAMES].sort()).toEqual([...SECRET_ENV_VARS].sort())
})

test('backendFor selects the OS-native store', () => {
  expect(backendFor('darwin')).toBe('keychain')
  expect(backendFor('linux')).toBe('libsecret')
  expect(backendFor('win32')).toBe('unsupported')
})

test('getArgv builds value-fetch commands (stdout-captured, never shelled)', () => {
  expect(getArgv('keychain', 'SESSION_SECRET')).toEqual([
    'security',
    ['find-generic-password', '-s', 'openlevel-SESSION_SECRET', '-w'],
  ])
  expect(getArgv('libsecret', 'SESSION_SECRET')).toEqual(['secret-tool', ['lookup', 'openlevel', 'SESSION_SECRET']])
  expect(() => getArgv('unsupported', 'X')).toThrow(/no secret backend/)
})

test('getSecret returns undefined on missing backends and absent items', () => {
  expect(getSecret('SESSION_SECRET', { platform: 'win32' })).toBeUndefined()
  expect(
    getSecret('SESSION_SECRET', { run: () => ({ status: 1, stdout: '' }), platform: 'linux' }),
  ).toBeUndefined()
  expect(getSecret('SESSION_SECRET', { run: () => ({ status: 0, stdout: '' }), platform: 'linux' })).toBeUndefined()
  expect(
    getSecret('SESSION_SECRET', {
      run: () => {
        throw new Error('no secret-tool')
      },
      platform: 'linux',
    }),
  ).toBeUndefined()
})

test('getSecret returns the stored value via the stubbed backend', () => {
  const seen: [string, string[]][] = []
  const value = getSecret('SESSION_SECRET', {
    platform: 'linux',
    run: (argv0: string, args: string[]) => {
      seen.push([argv0, args])
      return { status: 0, stdout: 's3cr3t\n' }
    },
  })
  expect(value).toBe('s3cr3t')
  expect(seen).toEqual([['secret-tool', ['lookup', 'openlevel', 'SESSION_SECRET']]])
})

test('resolveAll returns only the names the store holds', () => {
  const found = resolveAll({
    names: ['A', 'B'],
    getSecret: (name: string) => (name === 'A' ? 'va' : undefined),
  })
  expect(found).toEqual({ A: 'va' })
})

test('cmdExec injects resolved secrets, prints names only, propagates status', () => {
  const lines: string[] = []
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '))
  })
  let childEnv: Record<string, string | undefined> = {}
  try {
    cmdExec(['node', '-e', '1'], {
      resolveAll: () => ({ SESSION_SECRET: 'CANARY_EXEC_VALUE' }),
      spawn: ((cmd: string, args: string[], opts: { env?: Record<string, string | undefined> }) => {
        childEnv = opts.env ?? {}
        expect(cmd).toBe('node')
        return { status: 7 }
      }) as CmdExecDeps['spawn'],
    })
  } finally {
    logSpy.mockRestore()
  }
  expect(childEnv.SESSION_SECRET).toBe('CANARY_EXEC_VALUE')
  expect(lines.join('\n')).toContain('SESSION_SECRET')
  expect(lines.join('\n')).not.toContain('CANARY_EXEC_VALUE')
  expect(process.exitCode).toBe(7)
  process.exitCode = undefined
})

test('cmdExec with no command prints usage and sets exit 2', () => {
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    cmdExec([])
    expect(process.exitCode).toBe(2)
  } finally {
    errSpy.mockRestore()
    process.exitCode = undefined
  }
})
