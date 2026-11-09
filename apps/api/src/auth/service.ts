// Registration, sign-in and the current user.

import * as membersDb from '../db/members'
import * as organizationsDb from '../db/organizations'
import * as usersDb from '../db/users'
import { ApiError } from '../errors'
import { hashPassword, verifyPassword } from './password'
import { issueToken } from './token'
import type { Actor, User } from './types'

type AuthEnv = Pick<Env, 'DB' | 'JWT_SECRET'>

export type Session = { token: string; expiresAt: string; user: User }

/**
 * Creates a user with an organization they own, and signs them in. The organization is needed straight away:
 * the next onboarding step adds a domain to it.
 */
export async function register(
  env: AuthEnv,
  input: { name: string; email: string; password: string; organizationName?: string },
): Promise<Session & { organization: { id: string; name: string } }> {
  const email = input.email.trim().toLowerCase()
  const existing = await usersDb.findByEmail(env.DB, email)
  // Invited and never accepted: the account is theirs to claim through the invite link, which proves the email is
  // theirs. Signing up here doesn't, so it can't take over the invite.
  if (existing && !existing.password_hash) {
    throw new ApiError('invited', "You've been invited to xstate. Use the link in your invite email to set your password.", 409)
  }
  if (existing) throw emailTaken()

  const userId = crypto.randomUUID()
  const organization = { id: crypto.randomUUID(), name: input.organizationName ?? `${input.name}'s organization` }
  const now = new Date().toISOString()
  const passwordHash = await hashPassword(input.password)

  try {
    await env.DB.batch([
      usersDb.insert(env.DB, { id: userId, email, name: input.name, passwordHash, now }),
      organizationsDb.insert(env.DB, { ...organization, ownerId: userId, now }),
      membersDb.insert(env.DB, { id: crypto.randomUUID(), organizationId: organization.id, userId, role: 'owner', now }),
    ])
  } catch (err) {
    // Lost a race with another sign-up for the same email.
    if (String(err).includes('UNIQUE constraint failed: users.email')) throw emailTaken()
    throw err
  }

  return { ...(await issueToken(env, userId)), user: { id: userId, email, name: input.name, createdAt: now }, organization }
}

export async function login(env: AuthEnv, input: { email: string; password: string }): Promise<Session> {
  const user = await usersDb.findByEmail(env.DB, input.email.trim().toLowerCase())
  // Hash even when there's no such user, so response time doesn't reveal which emails are registered.
  const ok = await verifyPassword(input.password, user?.password_hash ?? (await dummyHash()))
  if (!user || !user.password_hash || !ok) throw new ApiError('invalid_credentials', 'Email or password is incorrect', 401)
  return { ...(await issueToken(env, user.id)), user: toUser(user) }
}

/** The signed-in user and the organizations they belong to. */
export async function getMe(env: AuthEnv, actor: Actor) {
  const user = await usersDb.findById(env.DB, actor.userId)
  if (!user) throw new ApiError('invalid_token', 'This account no longer exists', 401)
  const memberships = await membersDb.listForUser(env.DB, user.id)
  return {
    user: toUser(user),
    organizations: memberships.map((m) => ({
      id: m.organization_id,
      name: m.organization_name,
      role: m.role,
      memberId: m.member_id,
    })),
  }
}

function toUser(row: usersDb.UserRow): User {
  return { id: row.id, email: row.email, name: row.name, createdAt: row.created_at }
}

function emailTaken(): ApiError {
  return new ApiError('email_taken', 'An account with this email already exists', 409)
}

let dummy: Promise<string> | undefined
function dummyHash(): Promise<string> {
  return (dummy ??= hashPassword(crypto.randomUUID()))
}
