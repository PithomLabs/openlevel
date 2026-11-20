import { classifyAdoption } from './adopt-check'
import { type SchemaCatalog, diffCatalogs } from './catalog'

const BASE = '20261119000000'

function catalog(overrides: Partial<SchemaCatalog> = {}): SchemaCatalog {
  return {
    snapshotVersion: 1,
    pgMajor: '18',
    tables: {
      locations: {
        columns: {
          id: { type: 'text', nullable: false, default: null },
          branding: { type: 'jsonb', nullable: true, default: "'{}'::jsonb" },
        },
        constraints: ['PRIMARY KEY (id)'],
      },
    },
    indexes: ['CREATE INDEX locations_slug ON public.locations USING btree (slug)'],
    extensions: ['plpgsql'],
    ...overrides,
  }
}

/** In-memory AdoptionDb answering the catalog queries from a fixed catalog. */
function fakeDb(catalog: SchemaCatalog, recorded: boolean) {
  return {
    async query<T>(sql: string): Promise<T[]> {
      if (sql.includes('schema_migrations')) return (recorded ? [{ version: BASE }] : []) as T[]
      if (sql.includes('server_version')) return [{ major: catalog.pgMajor }] as T[]
      // NOTE: pg_index is checked before pg_constraint because the index
      // query itself references pg_constraint (conindid anti-join).
      if (sql.includes('pg_index')) return catalog.indexes.map((definition) => ({ definition })) as T[]
      if (sql.includes('pg_attribute')) {
        const rows = []
        for (const [table, spec] of Object.entries(catalog.tables)) {
          for (const [column, c] of Object.entries(spec.columns)) {
            rows.push({ table_name: table, column_name: column, data_type: c.type, nullable: c.nullable, column_default: c.default })
          }
        }
        return rows as T[]
      }
      if (sql.includes('pg_constraint')) {
        const rows = []
        for (const [table, spec] of Object.entries(catalog.tables)) {
          for (const definition of spec.constraints) rows.push({ table_name: table, definition })
        }
        return rows as T[]
      }
      if (sql.includes('pg_extension')) return catalog.extensions.map((extension_name) => ({ extension_name })) as T[]
      if (sql.includes('pg_class')) return Object.keys(catalog.tables).map((table_name) => ({ table_name })) as T[]
      throw new Error(`unexpected catalog query: ${sql.slice(0, 60)}`)
    },
  }
}

test('identical catalogs produce no divergences', () => {
  expect(diffCatalogs(catalog(), catalog())).toEqual([])
})

test('missing branding column is flagged (Review 11 exact case)', () => {
  const expected = catalog()
  const actual = catalog({
    tables: {
      locations: {
        columns: { id: { type: 'text', nullable: false, default: null } },
        constraints: ['PRIMARY KEY (id)'],
      },
    },
  })
  expect(diffCatalogs(expected, actual)).toContainEqual({
    kind: 'missing-column',
    detail: 'locations.branding',
  })
})

test('wrong column type and nullability are flagged', () => {
  const actual = catalog({
    tables: {
      locations: {
        columns: {
          id: { type: 'text', nullable: true, default: null },
          branding: { type: 'text', nullable: true, default: "'{}'::jsonb" },
        },
        constraints: ['PRIMARY KEY (id)'],
      },
    },
  })
  const kinds = diffCatalogs(catalog(), actual).map((d) => d.kind)
  expect(kinds.filter((k) => k === 'column-mismatch')).toHaveLength(2)
})

test('missing and unexpected tables, constraints, and indexes are flagged', () => {
  const actual = catalog({
    tables: {
      locations: { columns: catalog().tables.locations!.columns, constraints: [] },
      rogue: { columns: {}, constraints: [] },
    },
    indexes: [],
  })
  const divs = diffCatalogs(catalog(), actual)
  expect(divs).toContainEqual({ kind: 'missing-constraint', detail: 'locations: PRIMARY KEY (id)' })
  expect(divs).toContainEqual({ kind: 'unexpected-table', detail: 'rogue' })
  expect(divs).toContainEqual({
    kind: 'missing-index',
    detail: 'CREATE INDEX locations_slug ON public.locations USING btree (slug)',
  })
})

test('extra extensions are allowed (platform-owned), missing ones flagged', () => {
  expect(diffCatalogs(catalog(), catalog({ extensions: ['plpgsql', 'pg_stat_statements'] }))).toEqual([])
  expect(diffCatalogs(catalog(), catalog({ extensions: [] }))).toContainEqual({
    kind: 'missing-extension',
    detail: 'plpgsql',
  })
})

test('major-version and snapshot-version mismatches refuse', () => {
  expect(diffCatalogs(catalog(), catalog({ pgMajor: '17' }))).toHaveLength(1)
  expect(
    diffCatalogs(catalog(), catalog({ snapshotVersion: 999 as unknown as 1 })),
  ).toHaveLength(1)
})

test('empty database proceeds as fresh', async () => {
  const verdict = await classifyAdoption(fakeDb(catalog({ tables: {}, indexes: [] }), false), catalog(), BASE)
  expect(verdict).toEqual({ decision: 'proceed', reason: 'empty-database' })
})

test('compatible unrecorded database proceeds as adoption', async () => {
  const verdict = await classifyAdoption(fakeDb(catalog(), false), catalog(), BASE)
  expect(verdict).toEqual({ decision: 'proceed', reason: 'compatible-schema' })
})

test('recorded compatible database proceeds without re-checking drift', async () => {
  const verdict = await classifyAdoption(fakeDb(catalog(), true), catalog(), BASE)
  expect(verdict).toEqual({ decision: 'proceed', reason: 'baseline-recorded' })
})

test('recorded but drifted database still refuses', async () => {
  const drifted = catalog({ tables: {} })
  const verdict = await classifyAdoption(fakeDb(drifted, true), catalog(), BASE)
  expect(verdict.decision).toBe('refuse')
})

test('divergent database refuses with values-free detail', async () => {
  const drifted = catalog({
    tables: {
      locations: {
        columns: { id: { type: 'text', nullable: false, default: null } },
        constraints: [],
      },
    },
    indexes: [],
  })
  const verdict = await classifyAdoption(fakeDb(drifted, false), catalog(), BASE)
  expect(verdict.decision).toBe('refuse')
  if (verdict.decision === 'refuse') {
    expect(verdict.divergences.length).toBeGreaterThan(0)
    expect(JSON.stringify(verdict.divergences)).toContain('locations.branding')
  }
})
