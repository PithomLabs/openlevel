/**
 * Inference provenance gate (R14-12, approval refinement #4). Model egress
 * (Anthropic) must only ever see explicitly approved synthetic records —
 * PII redaction alone does NOT establish that data is synthetic, so
 * redaction is a complement, never the proof.
 *
 * The proof is a per-tenant owner attestation: `settings.syntheticAttested`
 * may only be set by the owner at provisioning time (staging/preview
 * tenants, the local demo seed). Until a tenant carries it, every
 * inference entry point refuses without calling the model:
 *
 *   - runOperatorAssistant (assistant chat + federation turns) → 403
 *   - draftConversationReply (composer drafts) → 403
 *   - handleAgentReply (autonomous/approve-first replies) → skipped + log
 *
 * Restoring real data into a location never attests it: attestation is a
 * deliberate write, so a local prod-data restore keeps inference off until
 * the owner explicitly (and accountably) flips it.
 */

export const SYNTHETIC_ATTESTED_KEY = 'syntheticAttested'

export const INFERENCE_REFUSAL =
  'assistant is not enabled for this tenant: model inference requires owner-attested synthetic data'

export function isInferenceAllowed(settings: Record<string, unknown> | null | undefined): boolean {
  return settings?.[SYNTHETIC_ATTESTED_KEY] === true
}
