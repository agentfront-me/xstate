import { z } from 'zod'
import { changePassword, getMe, login, register } from '../auth/service'
import { track, userHash } from '../analytics/events'
import { ensureBucketsInBackground } from '../storage/buckets'
import { defineOperation } from './define'

const email = z.email().max(254)
const password = z.string().min(8, 'Password must be at least 8 characters').max(256)

export const authRegister = defineOperation({
  name: 'auth_register',
  description: 'Create an xstate account and an organization it owns. Returns a session token.',
  input: z.object({
    name: z.string().trim().min(1).max(100),
    email,
    password,
    organizationName: z.string().trim().min(1).max(100).optional(),
  }),
  public: true,
  http: { method: 'POST', path: '/auth/register', status: 201 },
  mcp: false,
  run: async ({ env, waitUntil, ip }, input) => {
    const session = await register(env, input, ip)
    // The organization's R2 bucket. If this fails, the first file stored creates it instead.
    ensureBucketsInBackground(env, waitUntil, [session.organization.id])
    track(env, waitUntil, session.user.id, session.organization.id, 'Signed Up', { source: 'signup', role: 'owner' })
    return { ...session, userHash: await userHash(env, session.user.id) }
  },
})

export const authLogin = defineOperation({
  name: 'auth_login',
  description: 'Sign in with email and password. Returns a session token.',
  input: z.object({ email, password: z.string().min(1).max(256) }),
  public: true,
  http: { method: 'POST', path: '/auth/login' },
  mcp: false,
  run: async ({ env, ip }, input) => {
    const session = await login(env, input, ip)
    return { ...session, userHash: await userHash(env, session.user.id) }
  },
})

export const authChangePassword = defineOperation({
  name: 'auth_change_password',
  description:
    'Finish signing in after a temporary password: auth_login answered password_change_required with a changeToken. Sets the new password and returns a session token.',
  input: z.object({ changeToken: z.string().min(20).max(2000), password }),
  public: true,
  http: { method: 'POST', path: '/auth/password/change' },
  mcp: false,
  run: async ({ env }, input) => {
    const session = await changePassword(env, input)
    return { ...session, userHash: await userHash(env, session.user.id) }
  },
})

export const authMe = defineOperation({
  name: 'auth_me',
  description: 'The signed-in user and the organizations they belong to, with their role and member id in each.',
  input: z.object({}),
  http: { method: 'GET', path: '/auth/me' },
  mcp: { scope: 'profile', readOnly: true },
  run: async ({ env, actor, waitUntil }) => {
    const me = await getMe(env, actor)
    // Backfill: organizations created before buckets existed get theirs the next time their owner signs in.
    ensureBucketsInBackground(env, waitUntil, me.organizations.filter((o) => o.role === 'owner').map((o) => o.id))
    // For identify() in the app (xstate's own analytics): proves this user id is really the signed-in person.
    return { ...me, userHash: await userHash(env, me.user.id) }
  },
})

export const authOperations = [authRegister, authLogin, authChangePassword, authMe]
