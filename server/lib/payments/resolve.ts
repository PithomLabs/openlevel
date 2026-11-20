import type { Database } from '../../db/database'
import { LocationsRepo } from '../../repos/locations-repo'
import { sideEffectPolicyFromEnv } from '../sending/policy'
import { resolveSecret } from '../vault'
import type { PaymentProvider } from './provider'
import { createSquareAdapter } from './square-adapter'
import { createStripeAdapter } from './stripe-adapter'

/** What a location chose under settings.payments. */
export interface PaymentsSettings {
  provider?: 'stripe' | 'square' | 'none'
  /** Square's own location id (their concept, not ours) — required for Square. */
  squareLocationId?: string
}

export type ResolvedProvider =
  | { ok: true; provider: PaymentProvider }
  | { ok: false; reason: string }

/**
 * Build the payment adapter for one location from its settings + secrets.
 *
 * The provider choice and the Square location id live in settings.payments
 * (operator-editable); the credentials are the LOCATION's own processor keys,
 * resolved by NAME from the vault layer (D-36) — `<slug>:stripe:secret_key`
 * etc. — and handed straight to the adapter. A missing key reports a reason
 * instead of throwing so routes can answer 409 with honest copy.
 */
export async function resolvePaymentProvider(
  db: Database,
  locationId: string,
  env: Record<string, string | undefined> = process.env,
): Promise<ResolvedProvider> {
  const location = await new LocationsRepo(db).getById(locationId)
  if (!location) return { ok: false, reason: 'location not found' }

  const payments = (location.settings?.payments ?? {}) as PaymentsSettings
  const slug = location.client_slug ?? location.slug
  // Restricted preview / malformed identity: no payment adapter at all — real
  // money stays structurally unreachable (R14-03).
  const policy = sideEffectPolicyFromEnv(env)
  if (policy.mode === 'refuse') return { ok: false, reason: policy.reason }
  const staging = policy.mode === 'sink'

  if (payments.provider === 'stripe') {
    const secretKey = resolveSecret(`${slug}:stripe:secret_key`)
    const webhookSecret = resolveSecret(`${slug}:stripe:webhook_secret`)
    if (!secretKey || !webhookSecret) return { ok: false, reason: 'stripe keys are not configured' }
    // Staging fence (G4): live Stripe keys are recognizable by prefix, so
    // staging refuses them outright — only test-mode keys may resolve.
    if (staging && !secretKey.startsWith('sk_test_')) {
      return { ok: false, reason: 'live stripe keys are refused in staging (use a test key)' }
    }
    return { ok: true, provider: createStripeAdapter({ secretKey, webhookSecret }) }
  }

  if (payments.provider === 'square') {
    // Staging fence (G4): Square access tokens carry no sandbox marker the
    // app can verify, so staging refuses Square entirely until an explicit
    // sandbox configuration exists. Fail closed over real money.
    if (staging) return { ok: false, reason: 'square is disabled in staging (no verifiable sandbox mode)' }
    const accessToken = resolveSecret(`${slug}:square:access_token`)
    const webhookSignatureKey = resolveSecret(`${slug}:square:webhook_signature_key`)
    if (!accessToken || !webhookSignatureKey) return { ok: false, reason: 'square keys are not configured' }
    if (!payments.squareLocationId) return { ok: false, reason: 'square location id is not configured' }
    return {
      ok: true,
      provider: createSquareAdapter({
        accessToken,
        webhookSignatureKey,
        squareLocationId: payments.squareLocationId,
      }),
    }
  }

  return { ok: false, reason: 'no payment provider connected' }
}
