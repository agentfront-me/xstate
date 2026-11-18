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
    // A token for one purpose only (choosing a new password) is never a session.
    if (typeof payload.sub === 'string' && payload.sub && payload.purpose === undefined) return { userId: payload.sub }
  } catch {
    // Expired, malformed or wrongly signed: all the same answer.
  }
  throw new ApiError('invalid_token', 'Sign in again: the token is missing, invalid or expired', 401)
}

const CHANGE_TTL_SECONDS = 15 * 60

/**
 * After signing in with a temporary password: a short token that can only be used to choose a new password
 * (auth/service.ts changePassword). verifyToken rejects it, so it opens nothing else.
 */
export async function issuePasswordChangeToken(env: Pick<Env, 'JWT_SECRET'>, userId: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return sign({ sub: userId, purpose: 'password_change', iat: now, exp: now + CHANGE_TTL_SECONDS }, env.JWT_SECRET, 'HS256')
}

/** The user the change token was issued to, or throws 401. */
export async function verifyPasswordChangeToken(env: Pick<Env, 'JWT_SECRET'>, token: string): Promise<string> {
  try {
    const payload = await verify(token, env.JWT_SECRET, 'HS256')
    if (typeof payload.sub === 'string' && payload.sub && payload.purpose === 'password_change') return payload.sub
  } catch {
    // Expired, malformed or wrongly signed.
  }
  throw new ApiError('invalid_token', 'This sign-in has expired. Sign in again with your temporary password.', 401)
}
