// Types for the toolchain.mjs exports used by guard tests (keeps
// typecheck:scripts strict without converting the runtime file).
export const ENV_APP_MAP: {
  development: string
  staging: string
  production: string
}
export function isValidAppName(app: unknown): boolean
export function parseFlyConfig(
  body: string,
  label: string,
): { app: string; [key: string]: unknown }
export function parseDeployedDigest(stdout: string, app: string): string
