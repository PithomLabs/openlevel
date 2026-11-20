import { createMiddleware } from 'hono/factory'
import type { AppEnv } from '../app-env'
import type { Database } from '../db/database'
import { isOwnerRole } from '../lib/roles'
import { OperatorsRepo } from '../repos/operators-repo'

/**
 * Enforces that the authenticated operator may access the `:loc` in the path.
 * Must run AFTER operatorAuth. Membership AND the owner role are both
 * required (FIND-08); either failure is the same 403 so the response never
 * tells an attacker which check failed. On success sets `locationId` for the
 * location-scoped repos downstream.
 */
export function locationAccess(db: Database) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const operatorId = c.get('operatorId')
    if (!operatorId) return c.json({ error: 'unauthorized' }, 401)
    const locationId = c.req.param('loc')
    if (!locationId) return c.json({ error: 'location required' }, 400)
    const repo = new OperatorsRepo(db)
    const ok = await repo.hasAccess(operatorId, locationId)
    if (!ok) return c.json({ error: 'forbidden' }, 403)
    const role = await repo.getRole(operatorId)
    if (!isOwnerRole(role)) return c.json({ error: 'forbidden' }, 403)
    c.set('locationId', locationId)
    await next()
  })
}
