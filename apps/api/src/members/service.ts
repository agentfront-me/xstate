// Members of an organization and invitations to join one.
//
// Inviting creates the membership straight away, as 'invited' (and a users row without a password for someone new
// to xstate), so mailboxes, shares and imports can point at the member before they accept. The invite link holds a
// random token; only its SHA-256 is stored. Accepting sets the password (new people) and makes the membership
// active. Until then the member can't sign in to the organization or open anything in it.
//
// Who may do what: anyone in the organization sees the list. Inviting, sending again and removing need the
// members.manage permission (owners and admins have it). Only owners and admins can invite admins, change roles or
// remove an admin. Nobody can change or remove the owner. Anyone except the owner can leave.

import { hashPassword } from '../auth/password'
import { issueToken } from '../auth/token'
import type { Actor } from '../auth/types'
import * as invitationsDb from '../db/invitations'
import * as membersDb from '../db/members'
import type { MemberRow, MemberStatus, Role } from '../db/members'
import * as usersDb from '../db/users'
import { ApiError } from '../errors'
import { isAdmin, loadMember, requireOrgPermission } from '../mailserver/access'
import { sendSystemEmail, type SystemMailEnv } from '../mailserver/system-mail'
import { inviteEmail } from './invite-email'

export type MembersEnv = SystemMailEnv & Pick<Env, 'APP_URL' | 'JWT_SECRET'>

/** How long an invite link works. Sending again makes a new link with a new expiry. */
const INVITE_DAYS = 14

export type OrgMember = {
  id: string
  userId: string
  name: string | null
  email: string
  role: Role
  status: MemberStatus
  /** The signed-in user. */
  you: boolean
  joinedAt: string
  /** Invited members only: when the email last went out (null: not sent yet), and when the link stops working. */
  invite: { sentAt: string | null; expiresAt: string; invitedBy: string | null } | null
}

/** Whether the invite email went out. Outside production the link comes back too, since local mail goes nowhere. */
export type Delivery = { sent: boolean; reason?: string; inviteUrl?: string }

function toMember(row: MemberRow, actor: Actor): OrgMember {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    email: row.email,
    role: row.role,
    status: row.status,
    you: row.user_id === actor.userId,
    joinedAt: row.created_at,
    invite:
      row.status === 'invited' && row.expires_at
        ? { sentAt: row.sent_at, expiresAt: row.expires_at, invitedBy: row.invited_by_name }
        : null,
  }
}

const notFound = () => new ApiError('member_not_found', 'Member not found', 404)
const forbidden = (message: string) => new ApiError('forbidden', message, 403)

async function memberContext(env: MembersEnv, actor: Actor, memberId: string) {
  const target = await membersDb.findById(env.DB, memberId)
  if (!target) throw notFound()
  // Same answer as a missing member, so people outside the organization can't probe ids.
  const me = await membersDb.find(env.DB, target.organization_id, actor.userId)
  if (!me) throw notFound()
  return { target, me }
}

// ---------------------------------------------------------------------------------------------------------------
// Members

export async function listMembers(env: MembersEnv, actor: Actor, organizationId: string): Promise<OrgMember[]> {
  await loadMember(env, organizationId, actor.userId)
  return (await membersDb.listForOrg(env.DB, organizationId)).map((row) => toMember(row, actor))
}

export async function setRole(env: MembersEnv, actor: Actor, memberId: string, role: Exclude<Role, 'owner'>): Promise<OrgMember> {
  const { target, me } = await memberContext(env, actor, memberId)
  if (!isAdmin(me)) throw forbidden('Only owners and admins can change roles')
  if (target.role === 'owner') throw forbidden("The owner's role can't be changed")
  await membersDb.setRole(env.DB, memberId, role, new Date().toISOString()).run()
  return toMember((await membersDb.findById(env.DB, memberId))!, actor)
}

export async function removeMember(env: MembersEnv, actor: Actor, memberId: string): Promise<void> {
  const { target, me } = await memberContext(env, actor, memberId)
  if (target.role === 'owner') throw forbidden("The owner can't be removed")
  const leaving = target.user_id === actor.userId
  if (!leaving) {
    requireOrgPermission(me, 'members.manage')
    if (target.role === 'admin' && !isAdmin(me)) throw forbidden('Only owners and admins can remove an admin')
  }
  // A personal mailbox belongs to one person; removing them would leave it with nobody who can open it.
  const owns = await env.DB.prepare(
    `SELECT 1 FROM mailbox_access ma JOIN mailboxes mb ON mb.id = ma.mailbox_id
     WHERE ma.member_id = ? AND ma.access = 'owner' AND mb.kind = 'personal' LIMIT 1`,
  )
    .bind(memberId)
    .first()
  if (owns) {
    throw new ApiError(
      'member_has_mailbox',
      `${target.name || target.email} has a personal mailbox. Delete it, or turn it into a shared mailbox, before removing them.`,
      409,
    )
  }
  await membersDb.remove(env.DB, memberId).run()
  // Invited and never accepted: the placeholder account goes too, or they could never sign up on their own.
  if (target.status === 'invited') await usersDb.removeIfUnclaimed(env.DB, target.user_id).run()
}

// ---------------------------------------------------------------------------------------------------------------
// Inviting

export async function inviteMember(
  env: MembersEnv,
  actor: Actor,
  organizationId: string,
  input: { email: string; name?: string; role: Exclude<Role, 'owner'>; send: boolean },
): Promise<{ member: OrgMember; email: Delivery }> {
  const me = await loadMember(env, organizationId, actor.userId)
  requireOrgPermission(me, 'members.manage')
  if (input.role === 'admin' && !isAdmin(me)) throw forbidden('Only owners and admins can invite admins')

  const email = input.email.trim().toLowerCase()
  const user = await usersDb.findByEmail(env.DB, email)
  if (user) {
    const existing = await membersDb.findByUser(env.DB, organizationId, user.id)
    if (existing?.status === 'invited') throw new ApiError('already_invited', `${email} is already invited. Send the invite again instead.`, 409)
    if (existing) throw new ApiError('already_member', `${email} is already a member`, 409)
  }

  const now = new Date().toISOString()
  const memberId = crypto.randomUUID()
  const userId = user?.id ?? crypto.randomUUID()
  const token = newToken()
  try {
    await env.DB.batch([
      ...(user ? [] : [usersDb.insertInvited(env.DB, { id: userId, email, name: input.name?.trim() || null, now })]),
      membersDb.insert(env.DB, { id: memberId, organizationId, userId, role: input.role, status: 'invited', now }),
      invitationsDb.upsert(env.DB, {
        memberId,
        organizationId,
        tokenHash: await sha256(token),
        invitedBy: actor.userId,
        sentAt: null,
        expiresAt: expiry(),
        now,
      }),
    ])
  } catch (err) {
    // Lost a race with another invite or sign-up for the same email.
    if (String(err).includes('UNIQUE constraint failed')) throw new ApiError('already_member', `${email} was just added. Reload the list.`, 409)
    throw err
  }

  const delivery = input.send ? await deliver(env, actor, memberId, token) : { sent: false, reason: 'Not sent yet' }
  return { member: toMember((await membersDb.findById(env.DB, memberId))!, actor), email: delivery }
}

/** Sends the invite again, with a new link (the old one stops working). */
export async function resendInvite(env: MembersEnv, actor: Actor, memberId: string): Promise<{ member: OrgMember; email: Delivery }> {
  const { target, me } = await memberContext(env, actor, memberId)
  requireOrgPermission(me, 'members.manage')
  if (target.status !== 'invited') throw new ApiError('already_accepted', `${target.email} has already joined`, 409)
  const token = await newInvitation(env, actor, target)
  const delivery = await deliver(env, actor, memberId, token)
  return { member: toMember((await membersDb.findById(env.DB, memberId))!, actor), email: delivery }
}

/** Emails the invite link to the member (or to `sendTo`, the personal address a migration knows for them). */
async function deliver(env: MembersEnv, actor: Actor, memberId: string, token: string, sendTo?: string): Promise<Delivery> {
  const [target, inviter] = await Promise.all([membersDb.findById(env.DB, memberId), usersDb.findById(env.DB, actor.userId)])
  const org = await env.DB.prepare('SELECT name FROM organizations WHERE id = ?').bind(target!.organization_id).first<{ name: string }>()
  const url = inviteUrl(env, token)
  // The link is only handed back outside production: there it's how you test, since local mail goes nowhere.
  const devUrl = env.ENVIRONMENT === 'production' ? {} : { inviteUrl: url }

  const message = inviteEmail({
    url,
    organization: org?.name ?? 'an organization',
    inviter: inviter?.name || inviter?.email || 'Someone',
    inviteeName: target!.name,
    days: INVITE_DAYS,
  })
  try {
    const result = await sendSystemEmail(env, {
      to: { name: target!.name, email: sendTo ?? target!.email },
      replyTo: inviter ? { name: inviter.name, email: inviter.email } : undefined,
      ...message,
    })
    if (!result.sent) {
      console.warn('invite not sent:', result.reason)
      return { sent: false, reason: "xstate's own mail isn't set up on this server", ...devUrl }
    }
  } catch (err) {
    console.error('invite email failed', err)
    return { sent: false, reason: "The invite email couldn't be sent. Try again.", ...devUrl }
  }
  await invitationsDb.markSent(env.DB, memberId, new Date().toISOString()).run()
  return { sent: true, ...devUrl }
}

/**
 * An invite for someone a migration created (Finish step): a new link, emailed to `sendTo` (the personal address
 * Google had for them) when there is one. The link is always returned, so the admin can pass it on to people with
 * no personal address: their own address is on the organization's domain, whose mail now lands in the xstate
 * mailbox they can't open until they've accepted. Server-side only; never exposed as is.
 */
export async function migrationInvite(env: MembersEnv, actor: Actor, memberId: string, sendTo: string | null): Promise<{ url: string; sent: boolean }> {
  const target = await membersDb.findById(env.DB, memberId)
  if (!target || target.status !== 'invited') throw new ApiError('already_accepted', 'Already joined', 409)
  const token = await newInvitation(env, actor, target)
  const url = inviteUrl(env, token)
  if (!sendTo) return { url, sent: false }
  return { url, sent: (await deliver(env, actor, memberId, token, sendTo)).sent }
}

const inviteUrl = (env: MembersEnv, token: string) => `${env.APP_URL.replace(/\/+$/, '')}/invite/#${token}`

/** A new invite link for the member (the old one stops working). Returns the token to put in the link. */
async function newInvitation(env: MembersEnv, actor: Actor, target: { id: string; organization_id: string }): Promise<string> {
  const token = newToken()
  await invitationsDb
    .upsert(env.DB, {
      memberId: target.id,
      organizationId: target.organization_id,
      tokenHash: await sha256(token),
      invitedBy: actor.userId,
      sentAt: null,
      expiresAt: expiry(),
      now: new Date().toISOString(),
    })
    .run()
  return token
}

// ---------------------------------------------------------------------------------------------------------------
// Accepting (public: the token is the credential)

export type InviteInfo = {
  email: string
  name: string | null
  organization: { name: string }
  invitedBy: string | null
  role: Role
  /** New to xstate: they choose a password (and their name) to accept. */
  needsPassword: boolean
}

async function openInvitation(env: MembersEnv, token: string) {
  const row = await invitationsDb.findByTokenHash(env.DB, await sha256(token))
  if (!row) {
    throw new ApiError('invite_not_found', "This invite link doesn't work anymore. It may have been used, or replaced by a newer invite.", 404)
  }
  if (Date.parse(row.expires_at) < Date.now()) {
    const who = row.invited_by_name ? `Ask ${row.invited_by_name}` : 'Ask the person who invited you'
    throw new ApiError('invite_expired', `This invite has expired. ${who} to send it again.`, 404)
  }
  return row
}

export async function lookupInvite(env: MembersEnv, token: string): Promise<InviteInfo> {
  const row = await openInvitation(env, token)
  return {
    email: row.email,
    name: row.name,
    organization: { name: row.organization_name },
    invitedBy: row.invited_by_name,
    role: row.role as Role,
    needsPassword: !row.has_password,
  }
}

/**
 * Accepts an invite. Someone new sets their password and is signed in. Someone with an xstate account already
 * joins the organization and signs in as usual: the link alone never signs anyone in to an existing account.
 */
export async function acceptInvite(env: MembersEnv, input: { token: string; name?: string; password?: string }) {
  const row = await openInvitation(env, input.token)
  const now = new Date().toISOString()
  const organization = { id: row.organization_id, name: row.organization_name }

  if (row.has_password) {
    await env.DB.batch([membersDb.activate(env.DB, row.member_id, now), invitationsDb.remove(env.DB, row.member_id)])
    return { organization, signIn: true as const }
  }

  const name = input.name?.trim() || row.name
  if (!name) throw new ApiError('name_required', 'Enter your name')
  if (!input.password || input.password.length < 8) throw new ApiError('invalid_password', 'Use at least 8 characters for your password')
  const [setPassword] = await env.DB.batch([
    usersDb.setFirstPassword(env.DB, row.user_id, await hashPassword(input.password), name, now),
    membersDb.activate(env.DB, row.member_id, now),
    invitationsDb.remove(env.DB, row.member_id),
  ])
  // Someone set a password between the lookup and here (another tab): they sign in with it instead.
  if (!setPassword!.meta.changes) return { organization, signIn: true as const }
  return {
    organization,
    signIn: false as const,
    ...(await issueToken(env, row.user_id)),
    user: { id: row.user_id, email: row.email, name, createdAt: now },
  }
}

// ---------------------------------------------------------------------------------------------------------------

/** 32 random bytes, base64url: the part of the link that proves it came from the email. */
function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

const expiry = () => new Date(Date.now() + INVITE_DAYS * 24 * 60 * 60 * 1000).toISOString()
