import { createHash } from 'node:crypto'
import type { Database } from '../db/database'

/**
 * Request idempotency (FIND-07, G3). Keys are scoped by (tenant, operation):
 * the same key string in another location or operation is a different key.
 *
 * Semantics:
 * - First execution records (key, payload hash) and runs the operation.
 *   Callers with their own transaction record completion INSIDE it via
 *   completeIdempotencyKey (N4: commit and completion are atomic); the rest
 *   are completed here after fn returns.
 * - Same key + same payload hash replays the recorded result (no re-execution).
 * - Same key + different payload hash is a 409 conflict — never silent reuse.
 * - In-flight (in_progress) concurrent twin gets 409 'in progress': the
 *   client retries, and by then replays the recorded result. No server-side
 *   polling: bounded, honest, and easy to reason about.
 * - Crashed claims (in_progress older than staleAfterMs) are taken over by
 *   the next attempt atomically; the previous execution may or may not have
 *   finished, so operations must ALSO be safe under at-least-once execution
 *   (the outbox/dedup layers below provide that).
 * - Missing keys are the CALLER's decision (this primitive requires one):
 *   operations with natural identity derive a stable content key (booking);
 *   the rest mint a random key per request (no cross-retry dedup, but the
 *   atomic claims underneath still prevent double effects).
 */

export class IdempotencyConflict extends Error {
  readonly status = 409
  constructor(message: string) {
    super(message)
    this.name = 'IdempotencyConflict'
  }
}

export class IdempotencyInProgress extends Error {
  readonly status = 409
  constructor() {
    super('operation already in progress for this idempotency key — retry shortly')
    this.name = 'IdempotencyInProgress'
  }
}

export class InvalidIdempotencyKey extends Error {
  readonly status = 400
  constructor(message: string) {
    super(message)
    this.name = 'InvalidIdempotencyKey'
  }
}

/**
 * Parse the client-supplied Idempotency-Key header (R14-01). Returns null
 * when the client sent no key — the caller then executes the request as its
 * OWN logical submission with no cross-retry dedup (documented API
 * contract: clients needing retry safety MUST supply a stable key).
 *
 * Keys are opaque client-chosen submission identities: validated for shape
 * only (non-empty, bounded, no control characters), then bound to
 * (tenant, operation, payload hash) by withIdempotency. They carry no PII
 * and must never be derived from payload content — content-derived keys
 * collapse legitimately distinct submissions (R14-01).
 */
export function parseIdempotencyKey(header: string | undefined): string | null {
  if (header === undefined) return null
  const key = header.trim()
  if (key === '') throw new InvalidIdempotencyKey('Idempotency-Key must not be empty')
  if (key.length > 128) {
    throw new InvalidIdempotencyKey('Idempotency-Key must be 128 characters or fewer')
  }
  // Control characters have no business in an opaque key; reject, don't strip.
  if (/[\0-\x1f\x7f]/.test(key)) {
    throw new InvalidIdempotencyKey('Idempotency-Key must not contain control characters')
  }
  return key
}

export interface IdempotencyScope {
  locationId: string
  /** Stable operation name, e.g. 'campaign-send', 'booking-create'. */
  operation: string
  /** Client-supplied key (Idempotency-Key header) or caller-derived default. */
  key: string
  /** Business payload the key binds to; hashed canonically. */
  payload: unknown
}

export interface IdempotencyResult<T> {
  result: T
  /** True when the result was replayed instead of executed. */
  reused: boolean
}

/**
 * Record completion for a claimed key. The `status = 'in_progress'`
 * predicate makes this a no-op when the key already completed (a caller
 * whose business transaction records completion itself) or was released —
 * completion never resurrects or clobbers another attempt's terminal state.
 */
export async function completeIdempotencyKey(
  db: Pick<Database, 'query'>,
  scope: Pick<IdempotencyScope, 'locationId' | 'operation' | 'key'>,
  result: unknown,
): Promise<void> {
  await db.query(
    `UPDATE idempotency_keys SET status = 'completed', result = $4::jsonb, updated_at = now()
     WHERE location_id = $1 AND operation = $2 AND key = $3 AND status = 'in_progress'`,
    [scope.locationId, scope.operation, scope.key, JSON.stringify(result ?? null)],
  )
}

/**
 * Release a claimed key after a failed execution. Guarded to in_progress
 * rows: a twin that completed the same key while we were failing keeps its
 * completed record (N4: a late failure must not destroy a replayable result).
 */
async function releaseIdempotencyKey(
  db: Pick<Database, 'query'>,
  scope: Pick<IdempotencyScope, 'locationId' | 'operation' | 'key'>,
): Promise<void> {
  await db.query(
    `DELETE FROM idempotency_keys WHERE location_id = $1 AND operation = $2 AND key = $3 AND status = 'in_progress'`,
    [scope.locationId, scope.operation, scope.key],
  )
}

/**
 * Execute under a won claim (fresh or stale-takeover) and record completion.
 *
 * N4 contract: when `fn` runs its own transaction, it MUST record completion
 * inside that transaction via completeIdempotencyKey as its last statement —
 * then business commit and idempotency completion are one atomic unit and no
 * crash can leave them disagreeing. Callers without that need (non-txn work)
 * get completion here, after fn returns. The status re-check distinguishes
 * the two without a flag: completed rows are terminal, so a 'completed' read
 * after fn can only be our own in-txn record.
 */
async function executeAndComplete<T>(
  db: Database,
  scope: IdempotencyScope,
  fn: () => Promise<T>,
): Promise<IdempotencyResult<T>> {
  try {
    const result = await fn()
    const [row] = await db.query<{ status: string }>(
      `SELECT status FROM idempotency_keys WHERE location_id = $1 AND operation = $2 AND key = $3`,
      [scope.locationId, scope.operation, scope.key],
    )
    if (row?.status !== 'completed') {
      await completeIdempotencyKey(db, scope, result)
    }
    return { result, reused: false }
  } catch (err) {
    await releaseIdempotencyKey(db, scope)
    throw err
  }
}

/** Canonical JSON: sorted keys recursively, so equal payloads hash equally. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
}

export function payloadHash(payload: unknown): string {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex')
}

interface KeyRow {
  payload_hash: string
  status: string
  result: unknown
  updated_at: Date | string
}

export async function withIdempotency<T>(
  db: Database,
  scope: IdempotencyScope,
  fn: () => Promise<T>,
  opts: { staleAfterMs?: number } = {},
  depth = 0,
): Promise<IdempotencyResult<T>> {
  if (scope.key === '') throw new Error('withIdempotency requires a non-empty key')
  const staleAfterMs = opts.staleAfterMs ?? 60_000
  const hash = payloadHash(scope.payload)

  const inserted = await db.query<{ key: string }>(
    `INSERT INTO idempotency_keys (location_id, operation, key, payload_hash, status)
     VALUES ($1, $2, $3, $4, 'in_progress')
     ON CONFLICT DO NOTHING
     RETURNING key`,
    [scope.locationId, scope.operation, scope.key, hash],
  )
  if (inserted.length > 0) {
    // We won the claim: execute, then record (or release on failure).
    return executeAndComplete(db, scope, fn)
  }

  const [row] = await db.query<KeyRow>(
    `SELECT payload_hash, status, result, updated_at FROM idempotency_keys
     WHERE location_id = $1 AND operation = $2 AND key = $3`,
    [scope.locationId, scope.operation, scope.key],
  )
  if (!row) {
    // Lost the insert race AND the row vanished (winner failed and released):
    // retry as a fresh attempt rather than inventing an outcome, bounded so
    // pathological contention degrades to an honest 409 instead of recursing.
    if (depth >= 2) throw new IdempotencyInProgress()
    return withIdempotency(db, scope, fn, opts, depth + 1)
  }
  if (row.payload_hash !== hash) {
    throw new IdempotencyConflict(
      `idempotency key was already used with a different ${scope.operation} payload`,
    )
  }
  if (row.status === 'completed') return { result: row.result as T, reused: true }
  const updatedAt = row.updated_at instanceof Date ? row.updated_at.getTime() : Date.parse(String(row.updated_at))
  if (Number.isFinite(updatedAt) && Date.now() - updatedAt > staleAfterMs) {
    // Stale crash leftover: take over atomically (only one twin can win).
    const taken = await db.query<{ key: string }>(
      `UPDATE idempotency_keys SET updated_at = now()
       WHERE location_id = $1 AND operation = $2 AND key = $3
         AND status = 'in_progress' AND updated_at < now() - make_interval(secs => $4)
       RETURNING key`,
      [scope.locationId, scope.operation, scope.key, staleAfterMs / 1000],
    )
    if (taken.length > 0) {
      return executeAndComplete(db, scope, fn)
    }
  }
  throw new IdempotencyInProgress()
}
