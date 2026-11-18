// Admins helping a member with their password (docs/members-plan.md, phase 2): a new temporary password, or a link
// emailed to them to choose one. Plus the public side of that link.
//
// Who: people who manage members, for members other than themselves. Never the owner, and only the owner for an
// admin. A temporary password can only be set when the organization owns the person's sign-in (it's an address of
// their mailbox here): someone who signs in with their own email may belong to other organizations too.

import { hashPassword, verifyPassword } from '../auth/password'
import { issueToken } from '../auth/token'
import type { Actor } from '../auth/types'
import * as invitationsDb from '../db/invitations'
import * as membersDb from '../db/members'
import * as usersDb from '../db/users'
import { ApiError } from '../errors'
import { requireOrgPermission } from '../mailserver/access'
import { sendSystemEmail } from '../mailserver/system-mail'
import { generatePassword } from '../mailserver/validation'
import { resetEmail } from './reset-email'
import { requireNotSuspended, signOutUser } from './security'
import type { Delivery, MembersEnv } from './service'

const RESET_HOURS = 24

async function target(env: MembersEnv, actor: Actor, memberId: string) {
  const row = await membersDb.findById(env.DB, memberId)
  const me = row && (await membersDb.find(env.DB, row.organization_id, actor.userId))
  if (!row || !me) throw new ApiError('member_not_found', 'Member not found', 404)
  requireOrgPermission(me, 'members.manage')
  if (row.user_id === actor.userId) throw new ApiError('forbidden', "This is for other members' passwords, not your own", 403)
  if (row.role === 'owner') throw new ApiError('forbidden', "Nobody can change the owner's password", 403)
  if (row.role === 'admin' && me.role !== 'owner') throw new ApiError('forbidden', "Only the owner can change an admin's password", 403)
  // Whether their sign-in is an address of their own mailbox in this organization.
  const owned = !!(await env.DB.prepare(
    `SELECT 1 FROM addresses a JOIN mailbox_access ma ON ma.mailbox_id = a.mailbox_id AND ma.access = 'owner'
     WHERE ma.member_id = ? AND a.address = ? LIMIT 1`,
  )
    .bind(memberId, row.email)
    .first())
  return { row, owned }
}

/**
 * A new temporary password, returned once. They must choose their own at their next sign-in. Someone still invited
 * joins straight away with it, and their invite link stops working.
 */
export async function setTemporaryPassword(env: MembersEnv, actor: Actor, memberId: string): Promise<{ password: string }> {
  const { row, owned } = await target(env, actor, memberId)
  if (!owned) {
    throw new ApiError(
      'not_org_sign_in',
      `${row.email} isn't an address of this organization, so only they can change its password. Email them a reset link instead.`,
      409,
    )
  }
  const password = generatePassword()
  const now = new Date().toISOString()
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET password_hash = ?, must_change_password = 1, updated_at = ? WHERE id = ?').bind(await hashPassword(password), now, row.user_id),
    // Whoever had their old password is signed out.
    ...signOutUser(env, row.user_id, now),
    ...(row.status === 'invited' ? [membersDb.activate(env.DB, row.id, now), invitationsDb.remove(env.DB, row.id)] : []),
    env.DB.prepare('DELETE FROM password_resets WHERE user_id = ?').bind(row.user_id),
  ])
  return { password }
}

/** Emails a link to choose a new password: to their secondary email, or to their own email if that's their sign-in. */
export async function sendResetLink(env: MembersEnv, actor: Actor, memberId: string): Promise<{ email: Delivery & { to: string } }> {
  const { row, owned } = await target(env, actor, memberId)
  if (row.status === 'invited') throw new ApiError('still_invited', "They haven't accepted their invite yet. Send the invite again instead.", 409)
  const to = row.recovery_email ?? (owned ? null : row.email)
  if (!to) throw new ApiError('no_recovery_email', 'Add a secondary email for them first: they can’t read their xstate mailbox without signing in.', 409)

  const token = newToken()
  const now = new Date()
  await env.DB.prepare(
    `INSERT INTO password_resets (user_id, token_hash, created_by, expires_at, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET token_hash = excluded.token_hash, created_by = excluded.created_by,
       expires_at = excluded.expires_at, created_at = excluded.created_at`,
  )
    .bind(row.user_id, await sha256(token), actor.userId, new Date(now.getTime() + RESET_HOURS * 3_600_000).toISOString(), now.toISOString())
    .run()

  const url = `${env.APP_URL.replace(/\/+$/, '')}/reset/#${token}`
  const devUrl = env.ENVIRONMENT === 'production' ? {} : { inviteUrl: url }
  const [sender, org] = await Promise.all([
    usersDb.findById(env.DB, actor.userId),
    env.DB.prepare('SELECT name FROM organizations WHERE id = ?').bind(row.organization_id).first<{ name: string }>(),
  ])
  const message = resetEmail({ url, organization: org?.name ?? 'your organization', sender: sender?.name || sender?.email || 'An admin', name: row.name, email: row.email, hours: RESET_HOURS })
  try {
    const result = await sendSystemEmail(env, { to: { name: row.name, email: to }, ...message })
    if (!result.sent) return { email: { sent: false, reason: "xstate's own mail isn't set up on this server", to, ...devUrl } }
  } catch (err) {
    console.error('reset email failed', err)
    return { email: { sent: false, reason: "The email couldn't be sent. Try again.", to, ...devUrl } }
  }
  return { email: { sent: true, to, ...devUrl } }
}

// ---------------------------------------------------------------------------------------------------------------
// The link (public: the token is the credential)

async function openReset(env: MembersEnv, token: string) {
  const row = await env.DB.prepare(
    `SELECT r.user_id, r.expires_at, u.email, u.name, u.password_hash FROM password_resets r JOIN users u ON u.id = r.user_id WHERE r.token_hash = ?`,
  )
    .bind(await sha256(token))
    .first<{ user_id: string; expires_at: string; email: string; name: string | null; password_hash: string | null }>()
  if (!row) throw new ApiError('reset_not_found', "This link doesn't work anymore. It may have been used, or replaced by a newer one.", 404)
  if (Date.parse(row.expires_at) < Date.now()) throw new ApiError('reset_expired', 'This link has expired. Ask your admin to send a new one.', 404)
  return row
}

export async function lookupReset(env: MembersEnv, token: string): Promise<{ email: string; name: string | null }> {
  const row = await openReset(env, token)
  return { email: row.email, name: row.name }
}

/** Sets the password they chose and signs them in. The link works once. */
export async function completeReset(env: MembersEnv, input: { token: string; password: string }) {
  const row = await openReset(env, input.token)
  if (row.password_hash && (await verifyPassword(input.password, row.password_hash))) {
    throw new ApiError('same_password', 'Choose a password different from your current one')
  }
  const now = new Date().toISOString()
  const tokenHash = await sha256(input.token)
  // Only while the link is still open, so two tabs racing can't both use it.
  const [set] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ?
       WHERE id = ? AND EXISTS (SELECT 1 FROM password_resets WHERE user_id = ? AND token_hash = ?)`,
    ).bind(await hashPassword(input.password), now, row.user_id, row.user_id, tokenHash),
    env.DB.prepare('DELETE FROM password_resets WHERE user_id = ? AND token_hash = ?').bind(row.user_id, tokenHash),
    // Other sessions end; the one issued below (same second) still works.
    env.DB.prepare(
      'UPDATE users SET sessions_after = ? WHERE id = ? AND NOT EXISTS (SELECT 1 FROM password_resets WHERE user_id = ? AND token_hash = ?)',
    ).bind(now, row.user_id, row.user_id, tokenHash),
  ])
  if (!set!.meta.changes) throw new ApiError('reset_not_found', 'This link was just used. Sign in with your new password.', 404)
  await requireNotSuspended(env, row.user_id)
  return { ...(await issueToken(env, row.user_id)), user: { id: row.user_id, email: row.email, name: row.name, createdAt: now } }
}

function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
