import { Hono } from 'hono'
import type { AppEnv } from '../app-env'
import { FakeDatabase } from '../db/fake-database'
import { OWNER_ROLE, isOwnerRole } from '../lib/roles'
import { locationAccess } from './location-access'
import { requireOwner } from './require-owner'

test('role model: owner authorized, everything else denied (FIND-08)', () => {
  expect(OWNER_ROLE).toBe('owner')
  expect(isOwnerRole('owner')).toBe(true)
  for (const role of [undefined, null, '', 'viewer', 'member', 'admin', 'OWNER', ' owner']) {
    expect(isOwnerRole(role)).toBe(false)
  }
})

function locApp(db: FakeDatabase) {
  const app = new Hono<AppEnv>()
  app.use('/api/loc/:loc/*', (c, next) => {
    c.set('operatorId', 'op1')
    return next()
  })
  app.use('/api/loc/:loc/*', locationAccess(db))
  app.get('/api/loc/:loc/ping', (c) => c.json({ ok: true, loc: c.get('locationId') }))
  return app
}

test('locationAccess admits a member with the owner role', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ '?column?': 1 }]) // hasAccess -> member
  db.enqueue([{ role: 'owner' }]) // getRole -> owner
  const res = await locApp(db).request('/api/loc/locA/ping')
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ ok: true, loc: 'locA' })
})

test('locationAccess 403s a non-member with the identical body (FIND-08)', async () => {
  const db = new FakeDatabase()
  db.enqueue([]) // hasAccess -> none
  const res = await locApp(db).request('/api/loc/locA/ping')
  expect(res.status).toBe(403)
  expect(await res.json()).toEqual({ error: 'forbidden' })
})

test('locationAccess 403s a member whose role is not owner (FIND-08)', async () => {
  for (const role of ['viewer', 'member', 'admin', '']) {
    const db = new FakeDatabase()
    db.enqueue([{ '?column?': 1 }]) // hasAccess -> member
    db.enqueue([{ role }]) // getRole -> not owner
    const res = await locApp(db).request('/api/loc/locA/ping')
    expect(res.status, `role=${role}`).toBe(403)
    expect(await res.json()).toEqual({ error: 'forbidden' })
  }
})

test('locationAccess 403s a member whose operator row is gone (FIND-08)', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ '?column?': 1 }]) // hasAccess -> member (stale membership)
  db.enqueue([]) // getRole -> no such operator
  const res = await locApp(db).request('/api/loc/locA/ping')
  expect(res.status).toBe(403)
})

function ownerApp(db: FakeDatabase) {
  const app = new Hono<AppEnv>()
  app.use('/api/x', (c, next) => {
    c.set('operatorId', 'op1')
    return next()
  })
  app.use('/api/x', requireOwner(db))
  app.get('/api/x', (c) => c.json({ ok: true }))
  return app
}

test('requireOwner admits owners and 403s everyone else (FIND-08)', async () => {
  const ok = new FakeDatabase()
  ok.enqueue([{ role: 'owner' }])
  expect((await ownerApp(ok).request('/api/x')).status).toBe(200)

  for (const rows of [[{ role: 'viewer' }], [{}], []] as unknown[][]) {
    const db = new FakeDatabase()
    db.enqueue(rows as Record<string, unknown>[])
    const res = await ownerApp(db).request('/api/x')
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'forbidden' })
  }
})

test('requireOwner 401s without an operator identity', async () => {
  const app = new Hono<AppEnv>()
  app.use('/api/x', requireOwner(new FakeDatabase()))
  app.get('/api/x', (c) => c.json({ ok: true }))
  expect((await app.request('/api/x')).status).toBe(401)
})

test('role lookup projects only the role column, never the password hash (FIND-08)', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ role: 'owner' }])
  await ownerApp(db).request('/api/x')
  expect(db.calls).toHaveLength(1)
  expect(db.calls[0]?.sql).toMatch(/SELECT role FROM operators/i)
  expect(db.calls[0]?.sql).not.toMatch(/password_hash/)
  expect(db.calls[0]?.params).toEqual(['op1'])
})
