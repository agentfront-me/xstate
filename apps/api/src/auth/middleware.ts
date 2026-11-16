import { createMiddleware } from 'hono/factory'
import { ApiError } from '../errors'
import type { AppEnv } from '../http/types'
import { authenticateToken } from './api-tokens'
import { verifyToken } from './token'

const bearer = (header: string | undefined) => header?.match(/^Bearer\s+(\S+)$/i)?.[1]

/** Requires `Authorization: Bearer <JWT>` and sets `c.var.actor`. */
export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const token = bearer(c.req.header('Authorization'))
  if (!token) throw new ApiError('unauthenticated', 'Send Authorization: Bearer <token>', 401)
  c.set('actor', await verifyToken(c.env, token))
  await next()
})

/**
 * Requires `Authorization: Bearer xst_live_…`, a personal API token (auth/api-tokens.ts), and sets `c.var.actor`
 * (the token's owner, limited to its mailboxes) and `c.var.token`. Only the routes made for servers use it: a
 * session JWT is refused here, and a token is refused everywhere else.
 *
 * Wrong tokens are counted per IP (TOKEN_FAIL_RATE): past 20 a minute the answer is 429 until the minute is over.
 * A working token is never slowed down by that; it has its own limit of 300 requests a minute (EMAILS_RATE).
 */
export const requireToken = createMiddleware<AppEnv>(async (c, next) => {
  try {
    const auth = await authenticateToken(c.env, bearer(c.req.header('Authorization')), (p) => c.executionCtx.waitUntil(p))
    c.set('actor', auth.actor)
    c.set('token', auth.token)
    if (!(await c.env.EMAILS_RATE.limit({ key: auth.token.id })).success) {
      throw new ApiError('rate_limited', 'Too many requests with this token. At most 300 a minute.', 429)
    }
  } catch (err) {
    const ip = c.req.header('CF-Connecting-IP')
    if (err instanceof ApiError && err.code === 'invalid_token' && ip) {
      const { success } = await c.env.TOKEN_FAIL_RATE.limit({ key: ip })
      if (!success) throw new ApiError('rate_limited', 'Too many requests with a wrong API token. Wait a minute and try again.', 429)
    }
    throw err
  }
  await next()
})
