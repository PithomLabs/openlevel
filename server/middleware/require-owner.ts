import { createMiddleware } from 'hono/factory'
import type { AppEnv } from '../app-env'
import type { Database } from '../db/database'
import { OWNER_ROLE, isOwnerRole } from '../lib/roles'
import { OperatorsRepo } from '../repos/operators-repo'

/**
 * Owner-role gate for operator routes WITHOUT a location parameter
 * (/api/locations, /api/push-tokens, /api/auth/me). Must run AFTER
 * operatorAuth. Location-scoped routes get the equivalent check inside
 * locationAccess; this covers the rest so no session-authenticated route is
 * membership-only by accident. Unknown or missing roles 403, same as a
 * non-member (no oracle distinguishing the two cases).
 */
export function requireOwner(db: Database) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const operatorId = c.get('operatorId')
    if (!operatorId) return c.json({ error: 'unauthorized' }, 401)
    const role = await new OperatorsRepo(db).getRole(operatorId)
    if (!isOwnerRole(role)) return c.json({ error: 'forbidden' }, 403)
    await next()
  })
}

export { OWNER_ROLE }
