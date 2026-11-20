import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { PgliteDatabase } from '../server/db/pglite-database'
import { seedDatabase } from './seed'

const SCHEMA = readFileSync(fileURLToPath(new URL('./schema.sql', import.meta.url)), 'utf8')

test('R14-12: the demo seed attests its synthetic tenant for inference (and only via this write)', async () => {
  const pg = new PGlite()
  await pg.exec(SCHEMA)
  const db = new PgliteDatabase(pg)
  await seedDatabase(db)
  const [loc] = await db.query<{ id: string; settings: Record<string, unknown> }>(
    'SELECT id, settings FROM locations WHERE id = $1',
    ['loc_alex'],
  )
  expect(loc?.settings.syntheticAttested).toBe(true)
  // A second seed run is a no-op (existing tenant untouched, still attested).
  await seedDatabase(db)
  const [again] = await db.query<{ settings: Record<string, unknown> }>(
    'SELECT settings FROM locations WHERE id = $1',
    ['loc_alex'],
  )
  expect(again?.settings.syntheticAttested).toBe(true)
  const ops = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM operators WHERE id = $1', ['op_AL'])
  expect(ops[0]?.n).toBe(1)
})
