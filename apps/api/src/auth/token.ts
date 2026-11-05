// Session tokens: HS256 JWTs signed with JWT_SECRET. `sub` is the user id.

import { sign, verify } from 'hono/jwt'
import { ApiError } from '../errors'
import type { Actor } from './types'

const TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60

export async function issueToken(env: Pick<Env, 'JWT_SECRET'>, userId: string): Promise<{ token: string; expiresAt: string }> {
  const now = Math.floor(Date.now() / 1000)
  const exp = now + TOKEN_TTL_SECONDS
  const token = await sign({ sub: userId, iat: now, exp }, env.JWT_SECRET, 'HS256')
  return { token, expiresAt: new Date(exp * 1000).toISOString() }
}

/** Checks the signature and expiry and returns the actor, or throws 401. */
export async function verifyToken(env: Pick<Env, 'JWT_SECRET'>, token: string): Promise<Actor> {
  try {
    const payload = await verify(token, env.JWT_SECRET, 'HS256')
    if (typeof payload.sub === 'string' && payload.sub) return { userId: payload.sub }
  } catch {
    // Expired, malformed or wrongly signed: all the same answer.
  }
  throw new ApiError('invalid_token', 'Sign in again: the token is missing, invalid or expired', 401)
}
