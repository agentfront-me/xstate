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

import { revokeTokensOfMember } from '../auth/api-tokens'
import { hashPassword } from '../auth/password'
import { issueToken } from '../auth/token'
import type { Actor } from '../auth/types'
import * as addressesDb from '../db/addresses'
import * as domainsDb from '../db/domains'
import * as invitationsDb from '../db/invitations'
import * as membersDb from '../db/members'
import type { Member, MemberRow, MemberStatus, Role } from '../db/members'
import * as usersDb from '../db/users'
import { ApiError } from '../errors'
import { addAlias, createMailbox, deleteMailbox } from '../mailserver'
import { isAdmin, loadMember, requireOrgPermission } from '../mailserver/access'
import { generatePassword, normalizeLocalPart } from '../mailserver/validation'
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
  /** Where invites and reset links go. Only shown to the member themselves and to people who manage members. */
  recoveryEmail: string | null
  /** Their own mailbox in the organization, if they have one: every address, the primary (their sign-in) first. */
  mailbox: MemberMailbox | null
}

export type MemberMailbox = {
  id: string
  /** 'store': on the new mail system, where the primary address can be changed. */
  backend: 'stalwart' | 'store'
  addresses: { id: string; address: string; domainId: string; primary: boolean }[]
}

type Extras = { mailboxes: Map<string, MemberMailbox>; canManage: boolean }

async function extrasFor(env: MembersEnv, organizationId: string, me: Member, memberId?: string): Promise<Extras> {
  const mailboxes = new Map<string, MemberMailbox>()
  for (const r of await membersDb.personalMailboxes(env.DB, organizationId, memberId)) {
    let box = mailboxes.get(r.member_id)
    // One personal mailbox per member is the rule; if there were more, the first one found is theirs here.
    if (box && box.id !== r.mailbox_id) continue
    if (!box) mailboxes.set(r.member_id, (box = { id: r.mailbox_id, backend: r.backend, addresses: [] }))
    box.addresses.push({ id: r.address_id, address: r.address, domainId: r.domain_id, primary: !!r.is_primary })
  }
  return { mailboxes, canManage: canManage(me) }
}

const canManage = (me: Member) => isAdmin(me) || me.permissions.org.includes('members.manage')

/** Whether the invite email went out. Outside production the link comes back too, since local mail goes nowhere. */
export type Delivery = { sent: boolean; reason?: string; inviteUrl?: string }

function toMember(row: MemberRow, actor: Actor, extras?: Extras): OrgMember {
  const you = row.user_id === actor.userId
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    email: row.email,
    role: row.role,
    status: row.status,
    you,
    joinedAt: row.created_at,
    invite:
      row.status === 'invited' && row.expires_at
        ? { sentAt: row.sent_at, expiresAt: row.expires_at, invitedBy: row.invited_by_name }
        : null,
    recoveryEmail: you || extras?.canManage ? row.recovery_email : null,
    mailbox: extras?.mailboxes.get(row.id) ?? null,
  }
}

/** The member as the list shows them, after a change. */
async function reload(env: MembersEnv, actor: Actor, me: Member, memberId: string): Promise<OrgMember> {
  const row = (await membersDb.findById(env.DB, memberId))!
  return toMember(row, actor, await extrasFor(env, row.organization_id, me, memberId))
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
  const me = await loadMember(env, organizationId, actor.userId)
  const [rows, extras] = await Promise.all([membersDb.listForOrg(env.DB, organizationId), extrasFor(env, organizationId, me)])
  return rows.map((row) => toMember(row, actor, extras))
}

export async function setRole(env: MembersEnv, actor: Actor, memberId: string, role: Exclude<Role, 'owner'>): Promise<OrgMember> {
  const { target, me } = await memberContext(env, actor, memberId)
  if (!isAdmin(me)) throw forbidden('Only owners and admins can change roles')
  if (target.role === 'owner') throw forbidden("The owner's role can't be changed")
  await membersDb.setRole(env.DB, memberId, role, new Date().toISOString()).run()
  return reload(env, actor, me, memberId)
}

/**
 * Changes a member's name or recovery email. Members can change their own; people who manage members can change
 * anyone's except the owner's.
 */
export async function updateMember(
  env: MembersEnv,
  actor: Actor,
  memberId: string,
  changes: { name?: string; recoveryEmail?: string | null },
): Promise<OrgMember> {
  const { target, me } = await memberContext(env, actor, memberId)
  if (target.user_id !== actor.userId) {
    requireOrgPermission(me, 'members.manage')
    if (target.role === 'owner') throw forbidden("Only the owner can change the owner's details")
  }
  const recoveryEmail = changes.recoveryEmail === undefined ? undefined : changes.recoveryEmail?.trim().toLowerCase() || null
  if (recoveryEmail && recoveryEmail === target.email) {
    throw new ApiError('invalid_recovery_email', 'Use an address other than the one they sign in with')
  }
  await usersDb.update(env.DB, target.user_id, { name: changes.name?.trim() || undefined, recoveryEmail }, new Date().toISOString()).run()
  return reload(env, actor, me, memberId)
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
  // Their personal API tokens end with their membership, and the owners and admins hear which integrations stopped.
  if (target.status === 'active') {
    await revokeTokensOfMember(env, target.organization_id, { userId: target.user_id, name: target.name, email: target.email }, actor.userId).catch(
      (err) => console.error('revoking api tokens failed', err),
    )
  }
  // Invited and never accepted: the placeholder account goes too, or they could never sign up on their own.
  if (target.status === 'invited') await usersDb.removeIfUnclaimed(env.DB, target.user_id).run()
}

// ---------------------------------------------------------------------------------------------------------------
// Adding someone with a mailbox

export type AddMemberInput = {
  name: string
  role: Exclude<Role, 'owner'>
  /** Their mailbox's primary address, which is also what they sign in with. */
  mailbox: { localPart: string; domainId: string }
  /** More addresses delivering to the same mailbox, on any of the organization's domains. */
  alsoAt: { localPart: string; domainId: string }[]
  /** 'invite': a link to choose a password goes to recoveryEmail. 'password': a temporary password, returned once. */
  signIn: 'invite' | 'password'
  recoveryEmail?: string
}

/**
 * Adds someone with their own mailbox (docs/members-plan.md, phase 1). They sign in with its primary address. Every
 * address is checked before anything is created, and a failure part way through undoes what was made.
 */
export async function addMember(
  env: Env,
  actor: Actor,
  organizationId: string,
  input: AddMemberInput,
): Promise<{ member: OrgMember; email: Delivery | null; password?: string }> {
  const me = await loadMember(env, organizationId, actor.userId)
  requireOrgPermission(me, 'members.manage')
  if (input.role === 'admin' && !isAdmin(me)) throw forbidden('Only owners and admins can add admins')
  const name = input.name.trim()
  if (!name) throw new ApiError('name_required', 'Enter their name')

  // Every address, primary first: on the organization's domains, all handled by the same mail system, not repeated,
  // and free.
  const wanted = [input.mailbox, ...input.alsoAt]
  const domains = new Map<string, domainsDb.DomainRow>()
  const addresses: string[] = []
  for (const w of wanted) {
    const domain = domains.get(w.domainId) ?? (await domainsDb.find(env.DB, w.domainId))
    if (!domain || domain.organization_id !== organizationId) throw new ApiError('domain_not_found', 'Domain not found', 404)
    domains.set(domain.id, domain)
    const address = `${normalizeLocalPart(w.localPart)}@${domain.name}`
    if (addresses.includes(address)) throw new ApiError('duplicate_address', `${address} is listed twice`)
    addresses.push(address)
  }
  const primaryDomain = domains.get(input.mailbox.domainId)!
  for (const d of domains.values()) {
    if (d.mail_path !== primaryDomain.mail_path) {
      throw new ApiError(
        'domain_mail_path_differs',
        `${d.name} and ${primaryDomain.name} are handled by different mail systems right now, so one mailbox can't have addresses on both.`,
        409,
      )
    }
  }
  for (const address of addresses) {
    if ((await addressesDb.taken(env.DB, address)) || (await usersDb.findByEmail(env.DB, address))) {
      throw new ApiError('address_taken', `${address} is already in use`, 409)
    }
  }
  const primary = addresses[0]!

  const recoveryEmail = input.recoveryEmail?.trim().toLowerCase() || null
  if (input.signIn === 'invite' && !recoveryEmail) throw new ApiError('recovery_email_required', 'Enter the email to send their invite to')
  if (recoveryEmail && addresses.includes(recoveryEmail)) {
    throw new ApiError('invalid_recovery_email', "Use an email they can already read, not one of their new addresses")
  }

  const now = new Date().toISOString()
  const userId = crypto.randomUUID()
  const memberId = crypto.randomUUID()
  const password = input.signIn === 'password' ? generatePassword() : undefined
  const token = input.signIn === 'invite' ? newToken() : undefined
  try {
    await env.DB.batch([
      usersDb.insertWithMailbox(env.DB, { id: userId, email: primary, name, recoveryEmail, passwordHash: password ? await hashPassword(password) : null, now }),
      // With a temporary password they're in straight away; with an invite, once they accept it.
      membersDb.insert(env.DB, { id: memberId, organizationId, userId, role: input.role, status: token ? 'invited' : 'active', now }),
      ...(token
        ? [invitationsDb.upsert(env.DB, { memberId, organizationId, tokenHash: await sha256(token), invitedBy: actor.userId, sentAt: null, expiresAt: expiry(), now })]
        : []),
    ])
  } catch (err) {
    if (String(err).includes('UNIQUE constraint failed')) throw new ApiError('address_taken', `${primary} was just taken. Try another name.`, 409)
    throw err
  }

  let mailboxId: string | undefined
  try {
    const created = await createMailbox(env, actor, {
      kind: 'personal',
      domainId: input.mailbox.domainId,
      localPart: input.mailbox.localPart,
      displayName: name,
      ownerMemberId: memberId,
    })
    mailboxId = created.mailbox.id
    for (const alias of input.alsoAt) await addAlias(env, actor, mailboxId, alias)
  } catch (err) {
    // Undo, newest first. Each step is tried even if one before it fails, and the original error is what's reported.
    if (mailboxId) await deleteMailbox(env, actor, mailboxId).catch((e) => console.error('add member: undoing the mailbox failed', e))
    await env.DB.batch([membersDb.remove(env.DB, memberId), usersDb.remove(env.DB, userId)]).catch((e) =>
      console.error('add member: undoing the member failed', e),
    )
    throw err
  }

  const email = token ? await deliver(env, actor, memberId, token) : null
  return { member: await reload(env, actor, me, memberId), email, ...(password && { password }) }
}

/**
 * Makes another of the member's addresses their primary one, which is also what they sign in with. Only on the new
 * mail system: on the current mail server the primary address is the account's name.
 */
export async function setPrimaryAddress(env: Env, actor: Actor, memberId: string, addressId: string): Promise<OrgMember> {
  const { target, me } = await memberContext(env, actor, memberId)
  requireOrgPermission(me, 'members.manage')
  if (target.role === 'owner' && target.user_id !== actor.userId) throw forbidden("Only the owner can change the owner's addresses")
  const box = (await extrasFor(env, target.organization_id, me, memberId)).mailboxes.get(memberId)
  const next = box?.addresses.find((a) => a.id === addressId)
  if (!box || !next) throw new ApiError('address_not_found', 'Address not found', 404)
  if (next.primary) return reload(env, actor, me, memberId)
  if (box.backend !== 'store') {
    throw new ApiError(
      'primary_needs_new_mail_system',
      "The primary address can be changed once this domain has moved to xstate's new mail system.",
      409,
    )
  }
  const old = box.addresses.find((a) => a.primary)!
  const now = new Date().toISOString()
  const taken = await usersDb.findByEmail(env.DB, next.address)
  if (taken && taken.id !== target.user_id) throw new ApiError('address_taken', `${next.address} is already someone's sign-in`, 409)
  await env.DB.batch([
    env.DB.prepare('UPDATE addresses SET is_primary = (id = ?) WHERE mailbox_id = ?').bind(next.id, box.id),
    // Their sign-in follows the primary address, unless they sign in with an email of their own.
    ...(target.email === old.address ? [usersDb.setEmail(env.DB, target.user_id, next.address, now)] : []),
  ])
  return reload(env, actor, me, memberId)
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
  return { member: await reload(env, actor, me, memberId), email: delivery }
}

/** Sends the invite again, with a new link (the old one stops working). */
export async function resendInvite(env: MembersEnv, actor: Actor, memberId: string): Promise<{ member: OrgMember; email: Delivery }> {
  const { target, me } = await memberContext(env, actor, memberId)
  requireOrgPermission(me, 'members.manage')
  if (target.status !== 'invited') throw new ApiError('already_accepted', `${target.email} has already joined`, 409)
  const token = await newInvitation(env, actor, target)
  const delivery = await deliver(env, actor, memberId, token)
  return { member: await reload(env, actor, me, memberId), email: delivery }
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
      // Someone added with a mailbox can't read it yet: their invite goes to their recovery email.
      to: { name: target!.name, email: sendTo ?? target!.recovery_email ?? target!.email },
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
