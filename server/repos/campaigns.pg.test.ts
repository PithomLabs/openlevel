/**
 * Campaign claim race on real PostgreSQL (FIND-07): two concurrent sends of
 * the same draft must produce exactly one winner; the loser sees no row and
 * answers 409. The single UPDATE is the whole race protection.
 */
import { readFileSync } from 'node:fs'
import { inject } from 'vitest'
import { Pool } from 'pg'
import { PgDatabase } from '../db/database'
import { CampaignsRepo } from './campaigns-repo'

const baseUrl: string = inject('pgTestUrl') ?? process.env.OPENLEVEL_PG_TEST_URL ?? ''
if (baseUrl === '') throw new Error('pgTestUrl not provided — run via task test:pg')

const SCHEMA = readFileSync(new URL('../../db/schema.sql', import.meta.url), 'utf8')

beforeAll(async () => {
  const pool = new Pool({ connectionString: baseUrl })
  try {
    await pool.query(SCHEMA)
  } finally {
    await pool.end()
  }
})

test('concurrent claimForSend has exactly one winner', async () => {
  const pool = new Pool({ connectionString: baseUrl, max: 4 })
  try {
    const loc = `clm_${process.pid}_${Math.floor(Math.random() * 1e9)}`
    await pool.query(`INSERT INTO locations (id, name, slug) VALUES ($1, 'T', $1)`, [loc])
    const setup = new PgDatabase(pool)
    const created = await new CampaignsRepo(setup, loc).create({ name: 'Blast', body: 'hi' })
    const attempt = async () => {
      const db = new PgDatabase(pool)
      return new CampaignsRepo(db, loc).claimForSend(created.id)
    }
    const [a, b] = await Promise.all([attempt(), attempt()])
    const winners = [a, b].filter((r) => r !== undefined)
    expect(winners).toHaveLength(1)
    expect(winners[0]?.status).toBe('sending')
  } finally {
    await pool.end()
  }
})

test('stale sending claims are reclaimable; fresh ones are not', async () => {
  const pool = new Pool({ connectionString: baseUrl })
  try {
    const loc = `clm_${process.pid}_${Math.floor(Math.random() * 1e9)}`
    await pool.query(`INSERT INTO locations (id, name, slug) VALUES ($1, 'T', $1)`, [loc])
    const db = new PgDatabase(pool)
    const repo = new CampaignsRepo(db, loc)
    const stale = await repo.create({ name: 'Stale', body: 'hi' })
    await pool.query(`UPDATE campaigns SET status = 'sending', updated_at = now() - make_interval(hours => 1) WHERE id = $1`, [
      stale.id,
    ])
    const fresh = await repo.create({ name: 'Fresh', body: 'hi' })
    await pool.query(`UPDATE campaigns SET status = 'sending' WHERE id = $1`, [fresh.id])
    expect(await repo.claimForSend(stale.id)).toBeDefined()
    expect(await repo.claimForSend(fresh.id)).toBeUndefined()
  } finally {
    await pool.end()
  }
})
