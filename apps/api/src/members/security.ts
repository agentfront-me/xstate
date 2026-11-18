// Signing a member out everywhere, and suspending them (docs/members-plan.md, phase 3).
//
// Signing out sets users.sessions_after, which every session token is checked against (auth/token.ts), and forgets
// their phones, so alerts stop until they sign in again. Suspending also sets members.suspended_at: they then don't
// count as a member anywhere access is decided (db/members.ts find), so their sessions, personal API tokens and
// connected AI apps all stop reaching this organization, and nobody is notified on their behalf. Nothing is
// deleted: their mailbox keeps receiving mail, and restoring them brings everything back.
//
// Who: people who manage members. Never the owner; an admin only by an owner or admin. Anyone can sign
// themselves out everywhere.

import type { Actor } from '../auth/types'
import * as membersDb from '../db/members'
import { ApiError } from '../errors'
import { isAdmin, requireOrgPermission } from '../mailserver/access'
import { cancelDeletion } from './deletion'
import { getMember, type MembersEnv, type OrgMember } from './service'

async function context(env: MembersEnv, actor: Actor, memberId: string, self: 'allowed' | 'refused') {
  const target = await membersDb.findById(env.DB, memberId)
  const me = target && (await membersDb.find(env.DB, target.organization_id, actor.userId))
  if (!target || !me) throw new ApiError('member_not_found', 'Member not found', 404)
  if (target.user_id === actor.userId) {
    if (self === 'refused') throw new ApiError('forbidden', "You can't suspend yourself", 403)
    return target
  }
  requireOrgPermission(me, 'members.manage')
  if (target.role === 'owner') throw new ApiError('forbidden', "Nobody can do this to the owner", 403)
  if (target.role === 'admin' && !isAdmin(me)) throw new ApiError('forbidden', 'Only owners and admins can do this to an admin', 403)
  return target
}

/** Ends every session of the user, and forgets their phones. */
export function signOutUser(env: MembersEnv, userId: string, now: string): D1PreparedStatement[] {
  return [
    env.DB.prepare('UPDATE users SET sessions_after = ?, updated_at = ? WHERE id = ?').bind(now, now, userId),
    env.DB.prepare('DELETE FROM devices WHERE user_id = ?').bind(userId),
  ]
}

export async function signOutEverywhere(env: MembersEnv, actor: Actor, memberId: string): Promise<OrgMember> {
  const target = await context(env, actor, memberId, 'allowed')
  await env.DB.batch(signOutUser(env, target.user_id, new Date().toISOString()))
  console.log('member signed out everywhere', JSON.stringify({ by: actor.userId, userId: target.user_id, organizationId: target.organization_id }))
  return getMember(env, actor, memberId)
}

export async function suspendMember(env: MembersEnv, actor: Actor, memberId: string): Promise<OrgMember> {
  const target = await context(env, actor, memberId, 'refused')
  if (target.status !== 'active') throw new ApiError('not_active', "They haven't joined yet. Cancel their invite instead.", 409)
  const now = new Date().toISOString()
  await env.DB.batch([
    env.DB.prepare('UPDATE members SET suspended_at = COALESCE(suspended_at, ?), updated_at = ? WHERE id = ?').bind(now, now, memberId),
    ...signOutUser(env, target.user_id, now),
  ])
  console.log('member suspended', JSON.stringify({ by: actor.userId, userId: target.user_id, organizationId: target.organization_id }))
  return getMember(env, actor, memberId)
}

/** Gives a suspended member their access back, and undoes their deletion if one hasn't finished yet. */
export async function restoreMember(env: Env, actor: Actor, memberId: string): Promise<OrgMember> {
  await context(env, actor, memberId, 'refused')
  const now = new Date().toISOString()
  await env.DB.batch([
    ...(await cancelDeletion(env, memberId)),
    env.DB.prepare('UPDATE members SET suspended_at = NULL, updated_at = ? WHERE id = ?').bind(now, memberId),
  ])
  return getMember(env, actor, memberId)
}

/**
 * Refuses to sign in someone whose every membership is suspended: they'd get in and find nothing. Someone in no
 * organization at all (just signed up, or invited and not yet accepted) is let through as before.
 */
export async function requireNotSuspended(env: Pick<Env, 'DB'>, userId: string): Promise<void> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE suspended_at IS NULL) AS open FROM members WHERE user_id = ? AND status = 'active'",
  )
    .bind(userId)
    .first<{ total: number; open: number }>()
  if (row && row.total > 0 && row.open === 0) {
    throw new ApiError('suspended', 'Your access has been suspended. Ask an admin of your organization.', 403)
  }
}
