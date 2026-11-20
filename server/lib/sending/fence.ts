/**
 * Staging outbound fence (N5/N15, G4). In `APP_ENV=staging`, real provider
 * dispatch is structurally unavailable: messaging resolvers return the
 * controlled sink instead of provider adapters, and every sink send must
 * name a recipient on the server-side allowlist.
 *
 * Fail-closed rules:
 * - Staging with no STAGING_SINK_ALLOWLIST refuses ALL outbound sends.
 * - Staging with an allowlist sends (to the sink) only to listed recipients.
 * - Non-staging environments are unaffected by this module.
 *
 * The fence reads validated-env names directly (same source loadConfig
 * parses). Tests inject a record; production code passes nothing.
 *
 * Narrowed role (R14-03): this module asserts per-recipient allowlist
 * membership INSIDE the sink. The live/sink/refuse MODE decision lives in
 * the central side-effect policy (`./policy.ts`), which every provider path
 * consults — including restricted production preview, which this module
 * predates and does not model.
 */
export class FenceRefusal extends Error {
  readonly status = 403
  constructor(message: string) {
    super(message)
    this.name = 'FenceRefusal'
  }
}

export interface StagingFence {
  /** True only when APP_ENV=staging: sink-or-refuse is active. */
  sink: boolean
  /** Lowercased, trimmed allowlist entries (emails case-insensitive; E.164 exact). */
  allowlist: string[]
}

export function stagingFenceFromEnv(env: Record<string, string | undefined>): StagingFence {
  if (env.APP_ENV !== 'staging') return { sink: false, allowlist: [] }
  const allowlist = (env.STAGING_SINK_ALLOWLIST ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0)
  return { sink: true, allowlist }
}

/**
 * Refuse unless `to` is allowlisted. Throws FenceRefusal (never returns a
 * lie): an absent allowlist refuses everything, an unlisted recipient
 * refuses that send. No-op when the fence is inactive (non-staging).
 */
export function assertSinkRecipient(fence: StagingFence, to: string): void {
  if (!fence.sink) return
  if (!fence.allowlist.includes(to.trim().toLowerCase())) {
    throw new FenceRefusal(
      'staging fence: recipient is not on the STAGING_SINK_ALLOWLIST — refusing to send',
    )
  }
}
