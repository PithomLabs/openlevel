/**
 * Baseline adoption gate (FIND-05). Runs BEFORE dbmate in the release chain
 * and distinguishes the three database states:
 *
 *  - empty: no application tables -> PROCEED (dbmate creates everything).
 *  - compatible: catalog matches the committed snapshot (or the baseline is
 *    already recorded and still matches) -> PROCEED (dbmate adopts/records).
 *  - divergent: anything else -> REFUSE before dbmate records anything.
 *
 * Divergence details name objects only (tables/columns/constraints) — never
 * data, URLs, or credentials.
 */
import {
  type CatalogDivergence,
  RECORDER_TABLE,
  type SchemaCatalog,
  diffCatalogs,
  dumpCatalog,
} from './catalog'

export type AdoptionVerdict =
  | { decision: 'proceed'; reason: 'empty-database' }
  | { decision: 'proceed'; reason: 'compatible-schema' }
  | { decision: 'proceed'; reason: 'baseline-recorded' }
  | { decision: 'refuse'; divergences: CatalogDivergence[] }

export interface AdoptionDb {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>
}

async function baselineRecorded(db: AdoptionDb, baselineVersion: string): Promise<boolean> {
  try {
    const rows = await db.query<{ version: string }>(
      `SELECT version FROM ${RECORDER_TABLE} WHERE version = $1`,
      [baselineVersion],
    )
    return rows.length > 0
  } catch {
    // No recorder table (or no read access): treat as unrecorded. The catalog
    // diff below still governs; a genuinely broken target fails there.
    return false
  }
}

/**
 * Classify the connected target against the expected catalog. Pure decision
 * logic over the dumped catalog plus the recorder state; the caller decides
 * how to report/exit. `baselineVersion` is the dbmate baseline filename
 * stem (e.g. 20261119000000).
 */
export async function classifyAdoption(
  db: AdoptionDb,
  expected: SchemaCatalog,
  baselineVersion: string,
): Promise<AdoptionVerdict> {
  const recorded = await baselineRecorded(db, baselineVersion)
  const actual = await dumpCatalog(db)
  if (Object.keys(actual.tables).length === 0 && !recorded) {
    return { decision: 'proceed', reason: 'empty-database' }
  }
  const divergences = diffCatalogs(expected, actual)
  if (divergences.length > 0) return { decision: 'refuse', divergences }
  if (recorded) return { decision: 'proceed', reason: 'baseline-recorded' }
  return { decision: 'proceed', reason: 'compatible-schema' }
}

/** Values-free one-line rendering of each divergence for release logs. */
export function formatDivergences(divergences: CatalogDivergence[]): string[] {
  return divergences.map((d) => `${d.kind}: ${d.detail}`)
}
