import { createMiddleware } from 'hono/factory'
import { ApiError } from '../errors'
import type { AppEnv } from '../http/types'
import { verifyToken } from './token'

/** Requires `Authorization: Bearer <JWT>` and sets `c.var.actor`. */
export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const token = c.req.header('Authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1]
  if (!token) throw new ApiError('unauthenticated', 'Send Authorization: Bearer <token>', 401)
  c.set('actor', await verifyToken(c.env, token))
  await next()
})
