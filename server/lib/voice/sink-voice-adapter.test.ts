import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { PgliteDatabase } from '../../db/pglite-database'
import { FenceRefusal, stagingFenceFromEnv } from '../sending/fence'
import { createSinkVoiceAdapter } from './sink-voice-adapter'

const SCHEMA = readFileSync(fileURLToPath(new URL('../../../db/schema.sql', import.meta.url)), 'utf8')

async function setup() {
  const pg = new PGlite()
  await pg.exec(SCHEMA)
  const db = new PgliteDatabase(pg)
  await db.query("INSERT INTO locations (id, name, slug) VALUES ('locA','A','a')")
  return db
}

const fence = stagingFenceFromEnv({ APP_ENV: 'staging', STAGING_SINK_ALLOWLIST: '+15551230001' })

test('sink voice adapter records the would-be call with sink identity', async () => {
  const db = await setup()
  const voice = createSinkVoiceAdapter(db, 'locA', fence)
  expect(voice.name).toBe('sink')
  const placed = await voice.placeCall({ to: '+15551230001' })
  expect(placed.provider).toBe('sink')
  expect(placed.externalId).toMatch(/^sink-/)
  const rows = await db.query<{ channel: string; recipient: string; body: string }>(
    'SELECT channel, recipient, body FROM outbound_sink',
  )
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ channel: 'voice', recipient: '+15551230001' })
})

test('sink voice adapter refuses unlisted numbers and records nothing', async () => {
  const db = await setup()
  const voice = createSinkVoiceAdapter(db, 'locA', fence)
  await expect(voice.placeCall({ to: '+15550000000' })).rejects.toThrow(FenceRefusal)
  const rows = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM outbound_sink')
  expect(rows[0]?.n).toBe(0)
})
