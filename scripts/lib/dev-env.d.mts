/** Types for ./dev-env.mjs (kept for the typechecked server/vite importers). */
export interface DevConfig {
  host: string
  apiPort: number
  webPort: number
}
export declare const DEFAULT_HOST: string
export declare const DEFAULT_API_PORT: number
export declare const DEFAULT_WEB_PORT: number
export declare function resolveDevConfig(env?: Record<string, string | undefined>): DevConfig
export declare function endpointUrl(host: string, port: number): string
export declare function proxyTargetFor(config: Pick<DevConfig, 'host' | 'apiPort'>): string
export type BindFailureKind = 'in-use' | 'denied' | 'unavailable' | 'unknown'
export interface BindFailure {
  kind: BindFailureKind
  code: string
}
export declare function classifyBindError(err: unknown): BindFailure
export declare function describeBindFailure(input: {
  kind: BindFailureKind
  code: string
  label: string
  host: string
  port: number
  owner?: string | null
}): string
