import type { Database } from '../db/database'

/**
 * Canonical normalization (FIND-11, N7): separators collapse to underscores
 * and case folds, so `Alex:chatwoot:api_token` finds `Alex_CHATWOOT_API_TOKEN`.
 * Deliberately lossy — flat env keys cannot distinguish `:` from `-` from
 * ` ` — so tenant-namespace uniqueness is enforced at configuration time
 * (assertLocationNamespacesUnique): two locations whose effective slugs
 * normalize identically can never coexist, which is what keeps `acme-corp`
 * and `acme_corp` from silently sharing one credential. The lookup itself
 * still throws only on same-normalization env keys differing by case.
 */
export function normalizeSecretName(name: string): string {
  return name.replace(/[^A-Za-z0-9]+/g, '_').toLowerCase()
}

/**
 * Resolve a secret by name.
 *
 * Canonical rule (FIND-11): the item name is normalized with
 * normalizeSecretName, then matched against process.env keys
 * case-insensitively. Rationale:
 *
 * - Valid configured keys resolve regardless of the author's casing
 *   convention (mixed-case dev keys and all-caps deployed keys alike).
 * - Two env keys differing only by case are an explicit ambiguity error
 *   rather than a silent collision.
 * - Cross-tenant conflation (`acme-corp` vs `acme_corp`) is prevented
 *   structurally: locations with colliding namespaces are refused at boot
 *   (assertLocationNamespacesUnique), so no two tenants can share one key.
 * - Empty/missing values keep their existing pass-through semantics
 *   (undefined when unset); only malformed *names* throw, because a bad
 *   name is always a programmer error, never a missing credential.
 *
 * Later (D-36): this swaps for the Vaultwarden machine API. The agent never
 * sees a raw secret — this layer fetches the value and hands it only to the
 * outbound caller (e.g. the Chatwoot client), then the agent gets a
 * confirmation, not the credential.
 */
export function resolveSecret(name: string): string | undefined {
  if (!/[A-Za-z0-9]/.test(name)) {
    throw new Error('resolveSecret: invalid empty secret name')
  }
  const folded = normalizeSecretName(name)
  const matches = Object.keys(process.env).filter((k) => k.toLowerCase() === folded)
  if (matches.length > 1) {
    throw new Error(
      `resolveSecret: ambiguous secret name ${JSON.stringify(name)} matches ${matches.length} env keys differing only by case`,
    )
  }
  if (matches.length === 0) return undefined
  return process.env[matches[0] as string]
}

/**
 * N7 configuration validation: every location's effective secret namespace
 * (`client_slug ?? slug`, the prefix resolvers build secret names from) must
 * be unique under normalization. Two locations collapsing to one namespace
 * would silently share every provider credential — refuse loudly at boot so
 * the collision is fixed in data, never papered over in code. Slugs and ids
 * are non-secret identifiers, safe to name in the error.
 */
export async function assertLocationNamespacesUnique(db: Pick<Database, 'query'>): Promise<void> {
  const rows = await db.query<{ id: string; slug: string; client_slug: string | null }>(
    'SELECT id, slug, client_slug FROM locations',
  )
  const seen = new Map<string, { id: string; namespace: string }>()
  for (const row of rows) {
    const namespace = row.client_slug ?? row.slug
    if (namespace === null || namespace === undefined) continue
    const folded = normalizeSecretName(namespace)
    const prior = seen.get(folded)
    if (prior !== undefined && prior.id !== row.id) {
      throw new Error(
        `refusing to boot: locations ${JSON.stringify(prior.id)} (${JSON.stringify(prior.namespace)}) and ` +
          `${JSON.stringify(row.id)} (${JSON.stringify(namespace)}) share one secret namespace — ` +
          `rename one slug so tenant credentials cannot collide`,
      )
    }
    if (prior === undefined) seen.set(folded, { id: row.id, namespace })
  }
}
