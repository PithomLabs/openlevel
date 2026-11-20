/**
 * Secret hygiene: the canonical list of secret-bearing env var NAMES (never
 * values), plus the redaction primitives every process boundary uses before
 * anything reaches stdout/stderr/logs.
 *
 * Rules:
 * - Only NAMES live here. Values are collected at runtime from the loaded
 *   config or process.env and scrubbed from output; they are never stored.
 * - Per-client vault keys (<SLUG>_ANTHROPIC_API_KEY, <SLUG>_CHATWOOT_API_TOKEN,
 *   ...) cannot be enumerated — resolveSecret derives them dynamically — so
 *   URL-shaped leaks are ALSO scrubbed structurally (see redactUrl), and any
 *   caller that holds a client secret passes it explicitly for scrubbing.
 */

export const REDACTED = '[REDACTED]'

/**
 * Env vars whose values are secrets. Canonical list — scripts/lib/secret-store.mjs
 * mirrors these names for `task secrets:status`, pinned equal by
 * scripts/secret-store.test.ts. Docs: docs/security/SECRETS_MANAGEMENT.md.
 */
export const SECRET_ENV_VARS = [
  'DATABASE_URL',
  'SESSION_SECRET',
  'CHATWOOT_WEBHOOK_SECRET',
  'FEDERATION_SERVICE_TOKEN',
  'INTERNAL_PUSH_SECRET',
] as const

export type SecretEnvVar = (typeof SECRET_ENV_VARS)[number]

/** Collect the currently-set secret values for scrubbing. Memory only. */
export function collectEnvSecrets(env: Record<string, string | undefined>): string[] {
  const out: string[] = []
  for (const name of SECRET_ENV_VARS) {
    const value = env[name]
    if (value !== undefined && value !== '') out.push(value)
  }
  return out
}

/**
 * Replace every occurrence of each known secret value with [REDACTED].
 * Longest first so overlapping values (a URL containing a password that is
 * also listed separately) scrub fully. Empty values are skipped — scrubbing
 * '' would redact the gaps between every character.
 */
export function redactText(haystack: string, secrets: readonly (string | undefined | null)[]): string {
  const values = [...new Set(secrets.filter((s): s is string => typeof s === 'string' && s !== ''))].sort(
    (a, b) => b.length - a.length,
  )
  let out = haystack
  for (const secret of values) {
    out = out.split(secret).join(REDACTED)
  }
  return out
}

/**
 * Mask the password in postgres-style connection URLs:
 *   postgres://user:hunter2@host:5432/db  ->  postgres://user:****@host:5432/db
 * Structural (no secret list needed), so it also catches per-client vault
 * keys and URLs the caller forgot to list. Non-URL text passes through.
 */
export function redactUrl(text: string): string {
  return text.replace(
    /(\bpostgres(?:ql)?:\/\/[^/\s:@]+:)([^/\s@]+)(@)/gi,
    (_m, prefix: string, _password: string, at: string) => `${prefix}****${at}`,
  )
}

/** Scrub known secrets, then structurally mask any connection URL. */
export function redactAll(text: string, secrets: readonly (string | undefined | null)[]): string {
  return redactUrl(redactText(text, secrets))
}

export interface SafeError {
  name: string
  message: string
  stack?: string
  cause?: SafeError
}

/**
 * Serialize a thrown value for logs without leaking secrets: name + message
 * + (redacted) stack + (redacted) cause chain only. The full error object is
 * NEVER logged — pg and driver errors routinely embed the connection string
 * in `message`, `stack`, or bespoke fields, so bespoke fields are dropped
 * and the kept text is scrubbed twice (known secrets, then URL structure).
 * Cause chains are walked with a depth cap and cycle guard so a nested
 * provider error can neither leak nor hang the serializer.
 */
export function safeError(
  err: unknown,
  secrets: readonly (string | undefined | null)[] = [],
  depth = 0,
  seen: Set<object> = new Set(),
): SafeError {
  const name =
    err instanceof Error && err.name ? err.name : typeof err === 'object' && err !== null ? 'Error' : String(typeof err)
  const rawMessage = err instanceof Error ? err.message : String(err)
  const out: SafeError = { name, message: redactAll(rawMessage, secrets) }
  if (err instanceof Error && typeof err.stack === 'string' && err.stack !== '') {
    out.stack = redactAll(err.stack, secrets)
  }
  if (
    err instanceof Error &&
    err.cause !== undefined &&
    err.cause !== null &&
    depth < 5 &&
    (typeof err.cause !== 'object' || !seen.has(err.cause))
  ) {
    if (typeof err.cause === 'object') seen.add(err.cause)
    out.cause = safeError(err.cause, secrets, depth + 1, seen)
  }
  return out
}

/** One-line log form: `ErrorClass: scrubbed message`. */
export function formatSafeError(err: unknown, secrets: readonly (string | undefined | null)[] = []): string {
  const safe = safeError(err, secrets)
  return `${safe.name}: ${safe.message}`
}

/**
 * The centralized error-reporting boundary (FIND-01). Every execution path
 * that can reach stderr — Hono errors, pool/boss emitters, process fatals,
 * admin scripts — reports through here. Emits the scrubbed one-liner plus
 * the scrubbed stack; never the raw object, never config, never secrets.
 * Defaults to the ambient secret set so boundary call sites cannot forget it.
 */
export function reportError(
  source: string,
  err: unknown,
  secrets: readonly (string | undefined | null)[] = collectEnvSecrets(process.env),
): void {
  const safe = safeError(err, secrets)
  // Environment context on every error line (Review 11 P3): operators can
  // tell at a glance which deployment a log line came from. APP_ENV is a
  // non-secret identifier, safe to print unconditionally.
  const env = process.env.APP_ENV
  const tag = env ? `[${source} env=${env}]` : `[${source}]`
  console.error(`${tag} ${safe.name}: ${safe.message}`)
  let cause = safe.cause
  while (cause !== undefined) {
    console.error(`${tag} caused by ${cause.name}: ${cause.message}`)
    cause = cause.cause
  }
  if (safe.stack !== undefined) console.error(safe.stack)
}
