import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { PgliteDatabase } from '../../db/pglite-database'
import { FenceRefusal, stagingFenceFromEnv } from './fence'
import { createSinkSender } from './sink'

const SCHEMA = readFileSync(fileURLToPath(new URL('../../../db/schema.sql', import.meta.url)), 'utf8')

async function setup() {
  const pg = new PGlite()
  await pg.exec(SCHEMA)
  const db = new PgliteDatabase(pg)
  await db.query("INSERT INTO locations (id, name, slug) VALUES ('locA','A','a')")
  return db
}

const fence = stagingFenceFromEnv({ APP_ENV: 'staging', STAGING_SINK_ALLOWLIST: 'alice@example.com,+15551230001' })

test('sink records email + sms payloads with sink identity, never calling a provider', async () => {
  const db = await setup()
  const sink = createSinkSender(db, 'locA', fence)
  expect(sink.name).toBe('sink')
  const email = await sink.sendEmail({ to: 'ALICE@example.com', subject: 'Hi', text: 'hello' })
  const sms = await sink.sendSms({ to: '+15551230001', body: 'yo' })
  expect(email.provider).toBe('sink')
  expect(email.externalId).toMatch(/^sink-/)
  expect(sms.provider).toBe('sink')
  const rows = await db.query<{ channel: string; recipient: string; subject: string | null; body: string }>(
    'SELECT channel, recipient, subject, body FROM outbound_sink ORDER BY created_at',
  )
  expect(rows).toHaveLength(2)
  expect(rows[0]).toMatchObject({ channel: 'email', recipient: 'ALICE@example.com', subject: 'Hi', body: 'hello' })
  expect(rows[1]).toMatchObject({ channel: 'sms', recipient: '+15551230001', subject: null, body: 'yo' })
})

test('sink refuses unlisted recipients and records nothing (FenceRefusal)', async () => {
  const db = await setup()
  const sink = createSinkSender(db, 'locA', fence)
  await expect(sink.sendEmail({ to: 'bob@example.com', subject: 'x', text: 'y' })).rejects.toThrow(FenceRefusal)
  await expect(sink.sendSms({ to: '+15550000000', body: 'y' })).rejects.toThrow(FenceRefusal)
  const rows = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM outbound_sink')
  expect(rows[0]?.n).toBe(0)
})
