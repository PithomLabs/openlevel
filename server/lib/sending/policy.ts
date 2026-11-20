/**
 * Central side-effect policy (R14-03). EVERY outbound provider path — the
 * SMS/email/voice resolvers, the send-text rail, push, Chatwoot outbound,
 * payments, social — derives its ONE decision from here instead of scattering
 * `APP_ENV === 'staging'` checks:
 *
 *   - `live`:   provider delivery is allowed (development, production).
 *   - `sink`:   record into `outbound_sink`, never call a provider (staging).
 *   - `refuse`: refuse without recording (restricted production preview,
 *               malformed environment identity).
 *
 * Fail-closed rules:
 * - Staging always sinks; paths with an allowlist-able recipient additionally
 *   refuse when STAGING_SINK_ALLOWLIST is empty (that rule lives with the
 *   recipients, since some channels — Chatwoot, push — have none).
 * - Restricted production preview (APP_ENV=production + RESTRICTED_PREVIEW
 *   exactly 'true') refuses every external effect, even allowlisted ones.
 * - An APP_ENV value outside the known set refuses: an environment the app
 *   cannot identify must never deliver. (Boot validation rejects such values
 *   first; this is the backstop for raw-env readers.) An explicitly empty
 *   APP_ENV is set-but-invalid, not unset — it refuses like any other
 *   unrecognized value, matching the boot path's closed vocabulary.
 * - A missing or failed sink never falls through to live delivery: callers
 *   refuse or propagate the sink error, never continue to the provider.
 *
 * The fence module keeps its narrowed job — per-recipient allowlist assertion
 * inside the sink — while THIS module owns the mode decision.
 */

export type EffectMode = 'live' | 'sink' | 'refuse'

export interface SideEffectPolicy {
  mode: EffectMode
  /** Lowercased, trimmed STAGING_SINK_ALLOWLIST entries (meaningful in `sink` mode). */
  allowlist: string[]
  /** Human-readable reason, safe to surface in refusal details (no secrets). */
  reason: string
}

/** RESTRICTED_PREVIEW is exact-'true' (same convention as WORKFLOW_WAITS_ENABLED). */
export function isRestrictedPreview(env: Record<string, string | undefined>): boolean {
  return env.APP_ENV === 'production' && env.RESTRICTED_PREVIEW === 'true'
}

export function sideEffectPolicyFromEnv(env: Record<string, string | undefined>): SideEffectPolicy {
  const appEnv = env.APP_ENV
  if (appEnv === 'staging') {
    const allowlist = (env.STAGING_SINK_ALLOWLIST ?? '')
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0)
    return {
      mode: 'sink',
      allowlist,
      reason: 'staging: sends are recorded to the sink, never delivered',
    }
  }
  if (isRestrictedPreview(env)) {
    return {
      mode: 'refuse',
      allowlist: [],
      reason: 'restricted production preview: external effects are disabled',
    }
  }
  if (appEnv === 'production' || appEnv === 'development' || appEnv === undefined) {
    return { mode: 'live', allowlist: [], reason: `${appEnv || 'development'}: provider delivery` }
  }
  return {
    mode: 'refuse',
    allowlist: [],
    reason: `unrecognized APP_ENV '${appEnv}': refusing external effects until the environment identity is fixed`,
  }
}
