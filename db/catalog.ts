/**
 * Schema-catalog contract for baseline adoption (FIND-05).
 *
 * The catalog is the source of truth for "what the baseline means": every
 * table, column (type/nullability/default), constraint and index definition
 * exactly as PostgreSQL stores it. `db/snapshot-catalog.ts` generates it
 * from a fresh dbmate-migrated database; `db/adopt-check.ts` diffs a target
 * database against it before dbmate is allowed to record anything.
 *
 * Definitions come from pg_catalog (format_type, pg_get_constraintdef,
 * pg_get_indexdef) — no SQL text parsing, so there is no splitter to go
 * stale. Comparisons are exact within a PostgreSQL major; a major-version
 * mismatch refuses outright (rendering rules can change across majors).
 */

export interface CatalogColumn {
  type: string
  nullable: boolean
  /** Raw `column_default` expression, or null. Compared verbatim. */
  default: string | null
}

export interface CatalogTable {
  columns: Record<string, CatalogColumn>
  /** Canonical constraint definitions (pg_get_constraintdef), sorted. */
  constraints: string[]
}

export interface SchemaCatalog {
  /** Snapshot format version (bump on shape change; mismatches refuse). */
  snapshotVersion: 1
  /** PostgreSQL major the snapshot was taken on (adoption requires a match). */
  pgMajor: string
  /** table name -> contract. Never includes the dbmate recorder table. */
  tables: Record<string, CatalogTable>
  /** Canonical non-constraint index definitions (pg_get_indexdef), sorted. */
  indexes: string[]
  /** Extension names present. Target must be a SUPERSET (platform-owned). */
  extensions: string[]
}

export const SNAPSHOT_VERSION = 1 as const

/** dbmate's bookkeeping table: the recorder, never part of the contract. */
export const RECORDER_TABLE = 'schema_migrations'

export interface CatalogDivergence {
  kind:
    | 'missing-table'
    | 'unexpected-table'
    | 'missing-column'
    | 'unexpected-column'
    | 'column-mismatch'
    | 'missing-constraint'
    | 'unexpected-constraint'
    | 'missing-index'
    | 'unexpected-index'
    | 'missing-extension'
  /** Values-free detail: object names only, never data or credentials. */
  detail: string
}

/**
 * Diff an actual catalog against the expected contract. Order-independent
 * (multiset comparison on sorted definition lists). Returns every
 * divergence; empty means compatible.
 */
export function diffCatalogs(expected: SchemaCatalog, actual: SchemaCatalog): CatalogDivergence[] {
  const out: CatalogDivergence[] = []
  if (expected.snapshotVersion !== actual.snapshotVersion) {
    out.push({ kind: 'missing-table', detail: `snapshot version ${actual.snapshotVersion}, expected ${expected.snapshotVersion}` })
    return out
  }
  if (expected.pgMajor !== actual.pgMajor) {
    out.push({ kind: 'missing-table', detail: `server major ${actual.pgMajor}, snapshot taken on ${expected.pgMajor}` })
    return out
  }
  for (const [table, contract] of Object.entries(expected.tables)) {
    const got = actual.tables[table]
    if (!got) {
      out.push({ kind: 'missing-table', detail: table })
      continue
    }
    for (const [column, spec] of Object.entries(contract.columns)) {
      const g = got.columns[column]
      if (!g) {
        out.push({ kind: 'missing-column', detail: `${table}.${column}` })
      } else if (g.type !== spec.type || g.nullable !== spec.nullable || g.default !== spec.default) {
        out.push({
          kind: 'column-mismatch',
          detail: `${table}.${column} (expected ${spec.type} ${spec.nullable ? 'NULL' : 'NOT NULL'} default ${spec.default ?? 'none'})`,
        })
      }
    }
    for (const column of Object.keys(got.columns)) {
      if (!contract.columns[column]) out.push({ kind: 'unexpected-column', detail: `${table}.${column}` })
    }
    for (const want of multisetMinus(contract.constraints, got.constraints)) {
      out.push({ kind: 'missing-constraint', detail: `${table}: ${want}` })
    }
    for (const extra of multisetMinus(got.constraints, contract.constraints)) {
      out.push({ kind: 'unexpected-constraint', detail: `${table}: ${extra}` })
    }
  }
  for (const table of Object.keys(actual.tables)) {
    if (!expected.tables[table]) out.push({ kind: 'unexpected-table', detail: table })
  }
  for (const want of multisetMinus(expected.indexes, actual.indexes)) {
    out.push({ kind: 'missing-index', detail: want })
  }
  for (const extra of multisetMinus(actual.indexes, expected.indexes)) {
    out.push({ kind: 'unexpected-index', detail: extra })
  }
  for (const want of expected.extensions) {
    if (!actual.extensions.includes(want)) out.push({ kind: 'missing-extension', detail: want })
  }
  return out
}

function multisetMinus(a: string[], b: string[]): string[] {
  const rest = [...b]
  const missing: string[] = []
  for (const item of a) {
    const i = rest.indexOf(item)
    if (i === -1) missing.push(item)
    else rest.splice(i, 1)
  }
  return missing
}

export interface CatalogDb {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>
}

interface TableRow {
  table_name: string
}
interface ColumnRow {
  table_name: string
  column_name: string
  data_type: string
  nullable: boolean
  column_default: string | null
}
interface ConstraintRow {
  table_name: string
  definition: string
}
interface IndexRow {
  definition: string
}
interface ExtensionRow {
  extension_name: string
}

/**
 * Dump the live catalog contract of the connected database (public schema).
 * Excludes the dbmate recorder table and Postgres-internal objects.
 */
export async function dumpCatalog(db: CatalogDb): Promise<SchemaCatalog> {
  const version = await db.query<{ major: string }>(`SELECT split_part(setting, '.', 1) AS major FROM pg_settings WHERE name = 'server_version'`)
  const tables: Record<string, CatalogTable> = {}
  const tableRows = await db.query<TableRow>(
    `SELECT c.relname AS table_name FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> $1
     ORDER BY 1`,
    [RECORDER_TABLE],
  )
  for (const t of tableRows) tables[t.table_name] = { columns: {}, constraints: [] }
  const columnRows = await db.query<ColumnRow>(
    `SELECT c.relname AS table_name, a.attname AS column_name,
            format_type(a.atttypid, a.atttypmod) AS data_type,
            NOT a.attnotnull AS nullable,
            pg_get_expr(d.adbin, d.adrelid) AS column_default
     FROM pg_attribute a
     JOIN pg_class c ON c.oid = a.attrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> $1
       AND a.attnum > 0 AND NOT a.attisdropped
     ORDER BY 1, 2`,
    [RECORDER_TABLE],
  )
  for (const r of columnRows) {
    tables[r.table_name]!.columns[r.column_name] = {
      type: r.data_type,
      nullable: r.nullable,
      default: r.column_default,
    }
  }
  // Excludes not-null constraints: nullability is already in the column spec
  // (pg 18 reports domain/column NOT NULL as constraints; comparing them
  // separately would double-count and fuss over representation).
  const constraintRows = await db.query<ConstraintRow>(
    `SELECT c.relname AS table_name, pg_get_constraintdef(k.oid) AS definition
     FROM pg_constraint k
     JOIN pg_class c ON c.oid = k.conrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND k.contype <> 'n'
     ORDER BY 1, 2`,
    [],
  )
  for (const r of constraintRows) {
    const t = tables[r.table_name]
    if (t) t.constraints.push(r.definition)
  }
  const indexRows = await db.query<IndexRow>(
    `SELECT pg_get_indexdef(i.indexrelid) AS definition
     FROM pg_index i
     JOIN pg_class t ON t.oid = i.indrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public' AND t.relname <> $1 AND i.indisvalid
       AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = i.indexrelid)
     ORDER BY 1`,
    [RECORDER_TABLE],
  )
  const extensionRows = await db.query<ExtensionRow>(`SELECT extname AS extension_name FROM pg_extension ORDER BY 1`, [])
  return {
    snapshotVersion: SNAPSHOT_VERSION,
    pgMajor: version[0]?.major ?? 'unknown',
    tables,
    indexes: indexRows.map((r) => r.definition),
    extensions: extensionRows.map((r) => r.extension_name),
  }
}
