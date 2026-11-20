import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { FakeDatabase } from '../db/fake-database'
import { PgliteDatabase } from '../db/pglite-database'
import { ContactsRepo } from './contacts-repo'

test('upsertByMatch looks up identifiers independently, then inserts once (R13-12)', async () => {
  const db = new FakeDatabase()
  db.enqueue([]) // findByPhone -> no match
  db.enqueue([{ id: 'new', location_id: 'locA', created: true }]) // INSERT ... ON CONFLICT RETURNING
  const repo = new ContactsRepo(db, 'locA')
  const { contact: c, created } = await repo.upsertByMatch({ name: 'Bob', phone: '5035550199' }, 'chatwoot')
  expect(c.id).toBe('new')
  expect(created).toBe(true)
  expect(db.calls[0]?.sql).toMatch(/ANY\(phones\)/i)
  expect(db.calls[0]?.params[0]).toBe('locA')
  expect(db.calls[1]?.sql).toMatch(/ON CONFLICT \(location_id, match_key\)/i)
  expect(db.calls[1]?.sql).toMatch(/xmax = 0/i) // atomic created-flag detection
})

test('upsertByMatch resolves to the phone match without inserting (R13-12)', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: 'existing', location_id: 'locA', phones: ['+15035550199'], emails: [], archived_at: null }])
  const repo = new ContactsRepo(db, 'locA')
  const { contact: c, created } = await repo.upsertByMatch({ phone: '5035550199' }, 'chatwoot')
  expect(c.id).toBe('existing')
  expect(created).toBe(false)
  expect(db.calls).toHaveLength(1) // lookup only; no write for a clean match
})

test('upsertByMatch with no phone/email still inserts (anonymous contact)', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: 'anon', location_id: 'locA', created: true }]) // null match_key never matches the partial index -> always inserts
  const repo = new ContactsRepo(db, 'locA')
  const { contact: c, created } = await repo.upsertByMatch({ name: 'No Contact Info' }, 'manual')
  expect(c.id).toBe('anon')
  expect(created).toBe(true)
  expect(db.calls).toHaveLength(1)
})

test('upsertByMatch created flag is true on insert, false on match (real Postgres)', async () => {
  const pg = new PGlite()
  await pg.exec(readFileSync(fileURLToPath(new URL('../../db/schema.sql', import.meta.url)), 'utf8'))
  const db = new PgliteDatabase(pg)
  await db.query("INSERT INTO locations (id, name, slug) VALUES ('locA','A','a')")
  const repo = new ContactsRepo(db, 'locA')
  const first = await repo.upsertByMatch({ name: 'Bob', phone: '5035550199' }, 'chatwoot')
  expect(first.created).toBe(true)
  const second = await repo.upsertByMatch({ phone: '5035550199' }, 'manual')
  expect(second.contact.id).toBe(first.contact.id)
  expect(second.created).toBe(false)
})

test('listByTag scopes to location and filters on tag membership', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: 'c1', location_id: 'locA', tags: ['seller'] }])
  const repo = new ContactsRepo(db, 'locA')

  const out = await repo.listByTag('seller')
  expect(out).toHaveLength(1)
  expect(db.calls[0]?.sql).toMatch(/WHERE location_id = \$1 AND \$2 = ANY\(tags\)/i)
  expect(db.calls[0]?.params).toEqual(['locA', 'seller'])
})

test('addTag appends only when absent (idempotent) and scopes to location+id', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: 'c1', location_id: 'locA', tags: ['vip'] }])
  const repo = new ContactsRepo(db, 'locA')

  const c = await repo.addTag('c1', 'vip')
  expect(c?.tags).toEqual(['vip'])
  expect(db.calls[0]?.sql).toMatch(/array_append/i) // guarded so a repeat tag is a no-op
  expect(db.calls[0]?.params).toEqual(['locA', 'vip', 'c1'])
})

test('removeTag strips a tag and scopes to location+id', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: 'c1', location_id: 'locA', tags: [] }])
  const repo = new ContactsRepo(db, 'locA')

  const c = await repo.removeTag('c1', 'vip')
  expect(c?.tags).toEqual([])
  expect(db.calls[0]?.sql).toMatch(/array_remove/i)
  expect(db.calls[0]?.params).toEqual(['locA', 'vip', 'c1']) // same param order as addTag
})

test('setCustomField merges a value under its key (json-encoded) scoped to location+id', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: 'c1', location_id: 'locA', custom_fields: { roof_age: '12' } }])
  const repo = new ContactsRepo(db, 'locA')

  const c = await repo.setCustomField('c1', 'roof_age', '12')
  expect(c?.custom_fields).toEqual({ roof_age: '12' })
  expect(db.calls[0]?.sql).toMatch(/jsonb_build_object/i)
  expect(db.calls[0]?.params).toEqual(['locA', 'roof_age', '"12"', 'c1']) // value is JSON-encoded
})

test('setCustomField with a null value removes the key from the jsonb bag', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: 'c1', location_id: 'locA', custom_fields: {} }])
  const repo = new ContactsRepo(db, 'locA')

  const c = await repo.setCustomField('c1', 'roof_age', null)
  expect(c?.custom_fields).toEqual({})
  expect(db.calls[0]?.sql).toMatch(/custom_fields - \$2/i)
  expect(db.calls[0]?.params).toEqual(['locA', 'roof_age', 'c1']) // no value param on removal
})

// --- soft-delete (archive) ------------------------------------------------
// A "Delete" in the UI is a soft delete: it stamps archived_at so the contact
// drops out of the book but is fully restorable, because a hard delete would
// cascade away its notes/tasks/timeline and null out its conversations.

test('archive stamps archived_at = now() scoped to location+id, returns the row', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: 'c1', location_id: 'locA', archived_at: '2026-06-19T00:00:00Z' }])
  const repo = new ContactsRepo(db, 'locA')

  const c = await repo.archive('c1')
  expect(c?.id).toBe('c1')
  expect(db.calls[0]?.sql).toMatch(/archived_at = now\(\)/i)
  expect(db.calls[0]?.sql).toMatch(/WHERE location_id = \$1 AND id = \$2/i)
  expect(db.calls[0]?.params).toEqual(['locA', 'c1'])
})

test('archive returns undefined when the contact is not in this location', async () => {
  const db = new FakeDatabase()
  db.enqueue([]) // UPDATE ... RETURNING matched no row
  const repo = new ContactsRepo(db, 'locA')

  const c = await repo.archive('missing')
  expect(c).toBeUndefined()
})

test('restore clears archived_at (back to live) scoped to location+id', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: 'c1', location_id: 'locA', archived_at: null }])
  const repo = new ContactsRepo(db, 'locA')

  const c = await repo.restore('c1')
  expect(c?.archived_at).toBeNull()
  expect(db.calls[0]?.sql).toMatch(/archived_at = NULL/i)
  expect(db.calls[0]?.params).toEqual(['locA', 'c1'])
})

test('listArchived returns only archived rows, newest-archived first, location-scoped', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: 'c1', location_id: 'locA', archived_at: '2026-06-19T00:00:00Z' }])
  const repo = new ContactsRepo(db, 'locA')

  const out = await repo.listArchived()
  expect(out).toHaveLength(1)
  expect(db.calls[0]?.sql).toMatch(/archived_at IS NOT NULL/i)
  expect(db.calls[0]?.sql).toMatch(/ORDER BY archived_at DESC/i)
  expect(db.calls[0]?.params).toEqual(['locA', 200])
})

test('list hides archived contacts (archived_at IS NULL)', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: 'c1', location_id: 'locA' }])
  const repo = new ContactsRepo(db, 'locA')

  await repo.list()
  expect(db.calls[0]?.sql).toMatch(/archived_at IS NULL/i)
})

test('count excludes archived contacts (archived_at IS NULL)', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ n: 3 }])
  const repo = new ContactsRepo(db, 'locA')

  const n = await repo.count()
  expect(n).toBe(3)
  expect(db.calls[0]?.sql).toMatch(/archived_at IS NULL/i)
})

test('search excludes archived contacts (archived_at IS NULL)', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: 'c1', location_id: 'locA' }])
  const repo = new ContactsRepo(db, 'locA')

  await repo.search('bob')
  expect(db.calls[0]?.sql).toMatch(/archived_at IS NULL/i)
})

test('listByTag excludes archived contacts (archived_at IS NULL)', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: 'c1', location_id: 'locA', tags: ['seller'] }])
  const repo = new ContactsRepo(db, 'locA')

  await repo.listByTag('seller')
  expect(db.calls[0]?.sql).toMatch(/archived_at IS NULL/i)
})

// --- contact state (per-state legal texting hours) -------------------------
// The contact's US state pins which legal texting window the gateway enforces
// (8am-9pm in THAT state's own timezone, DST-aware). setState stores the
// 2-letter code; null clears it back to "not set", which the gateway then
// refuses as unknown_state rather than guessing a timezone. One statement for
// both set and clear (a plain column null is just state = $2), mirroring
// archive/restore — not the two-branch setCustomField shape.

test('setState stores the state code scoped to location+id, returns the row', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: 'c1', location_id: 'locA', state: 'AZ' }])
  const repo = new ContactsRepo(db, 'locA')

  const c = await repo.setState('c1', 'AZ')
  expect(c?.state).toBe('AZ')
  expect(db.calls[0]?.sql).toMatch(/SET state = \$2/i)
  expect(db.calls[0]?.sql).toMatch(/WHERE location_id = \$1 AND id = \$3/i)
  expect(db.calls[0]?.params).toEqual(['locA', 'AZ', 'c1'])
})

test('setState with null clears the state (back to not-set)', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: 'c1', location_id: 'locA', state: null }])
  const repo = new ContactsRepo(db, 'locA')

  const c = await repo.setState('c1', null)
  expect(c?.state).toBeNull()
  expect(db.calls[0]?.params).toEqual(['locA', null, 'c1']) // same SQL, null param
})

test('setState returns undefined when the contact is not in this location', async () => {
  const db = new FakeDatabase()
  db.enqueue([]) // UPDATE ... RETURNING matched no row
  const repo = new ContactsRepo(db, 'locA')

  const c = await repo.setState('missing', 'AZ')
  expect(c).toBeUndefined()
})

describe('R13-12 identity policy (real Postgres)', () => {
  async function setup() {
    const pg = new PGlite()
    await pg.exec(readFileSync(fileURLToPath(new URL('../../db/schema.sql', import.meta.url)), 'utf8'))
    const db = new PgliteDatabase(pg)
    await db.query("INSERT INTO locations (id, name, slug) VALUES ('locA','A','a')")
    return new ContactsRepo(db, 'locA')
  }

  async function seed(repo: ContactsRepo, over: Record<string, unknown> = {}) {
    const db = (repo as unknown as { db: PgliteDatabase }).db
    const id = `c${Math.floor(Math.random() * 1e9)}`
    await db.query(
      `INSERT INTO contacts (id, location_id, name, phones, emails, match_key, archived_at)
       VALUES ($1, 'locA', 'Seed', $2, $3, $4, $5)`,
      [
        id,
        (over.phones as string[] | undefined) ?? [],
        (over.emails as string[] | undefined) ?? [],
        (over.match_key as string | undefined) ?? null,
        (over.archived_at as string | undefined) ?? null,
      ],
    )
    return id
  }

  test('archived contact matched by email refuses without reusing or duplicating', async () => {
    const repo = await setup()
    const db = (repo as unknown as { db: PgliteDatabase }).db
    const id = await seed(repo, { emails: ['arch@example.com'], archived_at: '2026-01-01T00:00:00Z' })
    await expect(repo.upsertByMatch({ email: 'arch@example.com' }, 'form')).rejects.toMatchObject({
      name: 'ContactIdentityConflict',
      code: 'archived_match',
      contactIds: [id],
    })
    const rows = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM contacts WHERE location_id = 'locA'`)
    expect(rows[0]?.n).toBe(1)
  })

  test('archived contact matched by phone refuses without reusing or duplicating', async () => {
    const repo = await setup()
    const db = (repo as unknown as { db: PgliteDatabase }).db
    const id = await seed(repo, { phones: ['+16025550100'], archived_at: '2026-01-01T00:00:00Z' })
    await expect(repo.upsertByMatch({ phone: '+16025550100' }, 'form')).rejects.toMatchObject({
      name: 'ContactIdentityConflict',
      code: 'archived_match',
      contactIds: [id],
    })
    const rows = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM contacts WHERE location_id = 'locA'`)
    expect(rows[0]?.n).toBe(1)
  })

  test('same phone and same email on one contact resolves cleanly', async () => {
    const repo = await setup()
    const id = await seed(repo, { phones: ['+16025550101'], emails: ['same@example.com'] })
    const out = await repo.upsertByMatch({ phone: '+16025550101', email: 'same@example.com' }, 'form')
    expect(out.contact.id).toBe(id)
    expect(out.created).toBe(false)
  })

  test('same phone but a different populated email is a conflict (no silent drop/add)', async () => {
    const repo = await setup()
    await seed(repo, { phones: ['+16025550102'], emails: ['original@example.com'] })
    await expect(
      repo.upsertByMatch({ phone: '+16025550102', email: 'intruder@example.com' }, 'form'),
    ).rejects.toMatchObject({ name: 'ContactIdentityConflict', code: 'identity_conflict' })
  })

  test('same email but a different populated phone is a conflict', async () => {
    const repo = await setup()
    await seed(repo, { phones: ['+16025550103'], emails: ['stable@example.com'] })
    await expect(
      repo.upsertByMatch({ phone: '+19998887777', email: 'stable@example.com' }, 'form'),
    ).rejects.toMatchObject({ name: 'ContactIdentityConflict', code: 'identity_conflict' })
  })

  test('phone and email resolving to different records is a conflict naming both', async () => {
    const repo = await setup()
    const a = await seed(repo, { phones: ['+16025550104'] })
    const b = await seed(repo, { emails: ['split@example.com'] })
    await expect(
      repo.upsertByMatch({ phone: '+16025550104', email: 'split@example.com' }, 'form'),
    ).rejects.toMatchObject({ name: 'ContactIdentityConflict', code: 'identity_conflict', contactIds: [a, b] })
  })

  test('new email enriches a contact that has no email', async () => {
    const repo = await setup()
    const id = await seed(repo, { phones: ['+16025550105'] })
    const out = await repo.upsertByMatch({ phone: '+16025550105', email: 'fresh@example.com' }, 'form')
    expect(out.contact.id).toBe(id)
    expect(out.created).toBe(false)
    expect(out.contact.emails).toContain('fresh@example.com')
  })

  test('new phone enriches a contact that has no phone', async () => {
    const repo = await setup()
    const id = await seed(repo, { emails: ['lonely@example.com'] })
    const out = await repo.upsertByMatch({ phone: '+16025550106', email: 'lonely@example.com' }, 'form')
    expect(out.contact.id).toBe(id)
    expect(out.contact.phones).toContain('+16025550106')
  })

  test('same identifiers in another location insert independently (cross-tenant)', async () => {
    const repo = await setup()
    const db = (repo as unknown as { db: PgliteDatabase }).db
    await db.query("INSERT INTO locations (id, name, slug) VALUES ('locB','B','b')")
    const a = await repo.upsertByMatch({ phone: '+16025550107', email: 'cross@example.com' }, 'form')
    const b = await new ContactsRepo(db, 'locB').upsertByMatch({ phone: '+16025550107', email: 'cross@example.com' }, 'form')
    expect(a.created).toBe(true)
    expect(b.created).toBe(true)
    expect(a.contact.id).not.toBe(b.contact.id)
  })
})
