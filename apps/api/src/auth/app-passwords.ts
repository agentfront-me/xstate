// App passwords (docs/imap-smtp-relay-plan.md §4): how a mail or calendar app signs in. Settings → Access → App
// passwords creates and revokes them; the IMAP, SMTP and CalDAV sign-ins check them with authenticateApp.
//
// An app password belongs to one person in one organization. The app gives a mailbox's address as the username, and
// the password works for every mailbox its owner can open, with the access they have at that moment: a shared
// mailbox they can only read opens read-only, and one taken away in the app is out of reach on the next sign-in. It
// stops for good when its owner leaves the organization, and is refused while they are suspended or while the
// organization has mail apps turned off.
//
// Only the SHA-256 hash is stored. The password is returned once, by createAppPassword, and can't be shown again.

import * as addressesDb from '../db/addresses'
import * as db from '../db/app-passwords'
import type { AppPasswordRow } from '../db/app-passwords'
import * as mailboxAccessDb from '../db/mailbox-access'
import * as mailboxesDb from '../db/mailboxes'
import * as membersDb from '../db/members'
import * as usersDb from '../db/users'
import { ApiError } from '../errors'
import { isAdmin, loadMember, mailAccess } from '../mailserver/access'
import { paragraph, systemMailHtml } from '../mailserver/mail-html'
import { sendSystemEmail } from '../mailserver/system-mail'
import { MAX_APP_PASSWORDS, formatAppPassword, hashAppPassword, newAppPassword, normalizeAppPassword } from './app-password-rules.ts'
import type { Actor } from './types'

/** What mail apps are told to connect to (docs/imap-smtp-relay-plan.md, 3.2). */
export const MAIL_APP_SERVER = { host: 'mail.xstate.com', imapPort: 993, smtpPort: 465 } as const

export type AppPassword = {
  id: string
  name: string
  person: { userId: string; name: string | null; email: string; you: boolean }
  createdAt: string
  lastUsedAt: string | null
}

/** Whether mail apps are released to this organization yet (the MAIL_APPS var: off, on, or organization ids). */
export function mailAppsAvailable(env: Pick<Env, 'MAIL_APPS'>, organizationId: string): boolean {
  const setting: string = env.MAIL_APPS
  return setting === 'on' || setting.split(',').some((id) => id.trim() === organizationId)
}

const unavailable = () => new ApiError('mail_apps_unavailable', 'Mail and calendar apps aren’t available yet', 404)
const notFound = () => new ApiError('app_password_not_found', 'App password not found', 404)
const settingsUrl = (env: Pick<Env, 'APP_URL'>) => `${env.APP_URL.replace(/\/+$/, '')}/app/#/settings/app-passwords`

const present = (row: AppPasswordRow, person: AppPassword['person']): AppPassword => ({
  id: row.id,
  name: row.name,
  person,
  createdAt: row.created_at,
  lastUsedAt: row.last_used_at,
})

// ---------------------------------------------------------------------------------------------------------------
// Settings → Access → App passwords

/**
 * The actor's app passwords, or with `all` everyone's (owners and admins only). Also what the page shows beside
 * them: whether mail apps are on, and the server and usernames to type into a mail app.
 */
export async function listAppPasswords(env: Env, actor: Actor, organizationId: string, all: boolean) {
  const member = await loadMember(env, organizationId, actor.userId)
  const admin = isAdmin(member)
  if (all && !admin) throw new ApiError('forbidden', 'Only owners and admins can see everyone’s app passwords', 403)
  const [rows, people, enabled] = await Promise.all([
    db.list(env.DB, organizationId, all ? undefined : actor.userId),
    membersDb.listForOrg(env.DB, organizationId),
    db.appsDisabled(env.DB, organizationId).then((off) => !off),
  ])
  const byUser = new Map(people.filter((p) => p.status === 'active').map((p) => [p.user_id, p]))
  const passwords = rows.flatMap((row) => {
    const p = byUser.get(row.user_id)
    // Its owner left: it was revoked then, and is only still here if that failed. Nothing to show.
    return p ? [present(row, { userId: p.user_id, name: p.name, email: p.email, you: p.user_id === actor.userId })] : []
  })
  // Yours first, then newest.
  passwords.sort((a, b) => Number(b.person.you) - Number(a.person.you) || b.createdAt.localeCompare(a.createdAt))
  return { available: mailAppsAvailable(env, organizationId), passwords, enabled, canManage: admin, max: MAX_APP_PASSWORDS, server: MAIL_APP_SERVER }
}

/** Makes an app password for the actor. `secret` is the only time it is ever shown. */
export async function createAppPassword(
  env: Env,
  actor: Actor,
  organizationId: string,
  input: { name: string },
  waitUntil: (promise: Promise<unknown>) => void,
): Promise<{ password: AppPassword; secret: string }> {
  await loadMember(env, organizationId, actor.userId)
  if (!mailAppsAvailable(env, organizationId)) throw unavailable()
  if (await db.appsDisabled(env.DB, organizationId)) throw new ApiError('mail_apps_disabled', 'Mail and calendar apps are turned off for this organization', 403)
  if ((await db.countLive(env.DB, organizationId, actor.userId)) >= MAX_APP_PASSWORDS) {
    throw new ApiError('too_many_app_passwords', `You can have at most ${MAX_APP_PASSWORDS} app passwords. Revoke one you no longer use.`, 409)
  }
  const secret = newAppPassword()
  const row = {
    id: crypto.randomUUID(),
    organization_id: organizationId,
    user_id: actor.userId,
    name: input.name,
    password_hash: await hashAppPassword(secret),
    created_at: new Date().toISOString(),
  }
  await db.insert(env.DB, row)
  console.log('app password created', JSON.stringify({ id: row.id, userId: actor.userId, organizationId }))
  const user = await usersDb.findById(env.DB, actor.userId)
  if (user) {
    const lines = [`An app password named "${row.name}" was just created on your xstate account. A mail or calendar app can use it to read and send your mail.`]
    const footnote = 'If this wasn’t you, revoke it in Settings → Access → App passwords and change your password.'
    const url = settingsUrl(env)
    waitUntil(
      sendSystemEmail(env, {
        to: { name: user.name, email: user.email },
        subject: `New app password: ${row.name}`,
        text: `${lines.join('\n\n')}\n\nOpen app passwords:\n${url}\n\n${footnote}\n`,
        html: systemMailHtml({ paragraphs: lines.map((l) => paragraph(l)), button: { text: 'Open app passwords', url }, footnote }),
      }).catch((err) => console.error('app password email failed', err)),
    )
  }
  const person = { userId: actor.userId, name: user?.name ?? null, email: user?.email ?? '', you: true }
  return { password: present({ ...row, last_used_at: null, revoked_at: null, revoked_by: null }, person), secret: formatAppPassword(secret) }
}

/** Ends an app password at once. Your own; owners and admins can revoke anyone's. */
export async function revokeAppPassword(env: Env, actor: Actor, organizationId: string, id: string): Promise<void> {
  const member = await loadMember(env, organizationId, actor.userId)
  const row = await db.find(env.DB, organizationId, id)
  // Same answer for one that doesn't exist and one this person may not see.
  if (!row || row.revoked_at || (row.user_id !== actor.userId && !isAdmin(member))) throw notFound()
  await db.revoke(env.DB, row.id, actor.userId, new Date().toISOString())
  console.log('app password revoked', JSON.stringify({ id: row.id, by: actor.userId, userId: row.user_id, organizationId }))
}

/** Turns mail and calendar apps on or off for the whole organization. Off refuses every sign-in; none is deleted. */
export async function setMailAppsEnabled(env: Env, actor: Actor, organizationId: string, enabled: boolean): Promise<{ enabled: boolean }> {
  const member = await loadMember(env, organizationId, actor.userId)
  if (!isAdmin(member)) throw new ApiError('forbidden', 'Only owners and admins can turn mail apps on or off', 403)
  await db.setAppsDisabled(env.DB, organizationId, !enabled)
  console.log('mail apps switched', JSON.stringify({ organizationId, enabled, by: actor.userId }))
  return { enabled }
}

// ---------------------------------------------------------------------------------------------------------------
// Checking a sign-in

export type AppSignIn =
  | {
      ok: true
      passwordId: string
      userId: string
      organizationId: string
      mailboxId: string
      /** The mailbox's primary address, whichever of its addresses was typed. */
      address: string
      /** False for a shared mailbox the person can only read: it opens read-only and can't send. */
      canWrite: boolean
    }
  /** invalid: wrong address or password, or no access (never said which). throttled: too many tries this minute. */
  | { ok: false, reason: 'invalid' | 'throttled' | 'disabled' }

type SignInEnv = Pick<Env, 'DB' | 'MAIL_APPS' | 'APP_LOGIN_ADDRESS_RATE' | 'APP_LOGIN_IP_RATE'>

/**
 * Checks a mail or calendar app's sign-in: `address` is the mailbox it wants, `password` an app password of someone
 * who can open that mailbox. Every try counts toward the limits, right or wrong: 10 a minute per address, and a much
 * looser 300 a minute per IP, because some apps connect from their maker's servers and many people share those.
 */
export async function authenticateApp(env: SignInEnv, address: string, password: string, ip: string | undefined): Promise<AppSignIn> {
  const typed = address.trim().toLowerCase()
  const [byAddress, byIp] = await Promise.all([
    env.APP_LOGIN_ADDRESS_RATE.limit({ key: typed.slice(0, 320) }),
    ip ? env.APP_LOGIN_IP_RATE.limit({ key: ip }) : { success: true },
  ])
  if (!byAddress.success || !byIp.success) return { ok: false, reason: 'throttled' }

  const invalid = { ok: false, reason: 'invalid' } as const
  const normal = normalizeAppPassword(password)
  if (!normal) return invalid
  const row = await db.findByHash(env.DB, await hashAppPassword(normal))
  if (!row || row.revoked_at || !mailAppsAvailable(env, row.organization_id)) return invalid
  const place = await addressesDb.findByAddress(env.DB, typed)
  if (!place || place.organization_id !== row.organization_id) return invalid
  // Not an active member any more (left, or suspended): same answer as a wrong password.
  const member = await membersDb.find(env.DB, row.organization_id, row.user_id)
  if (!member) return invalid
  if (await db.appsDisabled(env.DB, row.organization_id)) return { ok: false, reason: 'disabled' }
  const mailbox = await mailboxesDb.find(env.DB, place.mailbox_id)
  if (!mailbox) return invalid
  const own = (await mailboxAccessDb.find(env.DB, mailbox.id, member.id))?.access
  const access = mailAccess(member, mailbox, own)
  if (!access.read) return invalid
  await db.touch(env.DB, row.id, new Date()).catch((err) => console.error('app password touch failed', err))
  return {
    ok: true,
    passwordId: row.id,
    userId: row.user_id,
    organizationId: row.organization_id,
    mailboxId: mailbox.id,
    address: mailbox.address,
    canWrite: access.write,
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Upkeep

/** Revokes every app password a person has in an organization. Called when a member is removed or leaves. */
export async function revokeAppPasswordsOfMember(env: Pick<Env, 'DB'>, organizationId: string, userId: string, by: string | null): Promise<void> {
  const count = await db.revokeForUser(env.DB, organizationId, userId, by, new Date().toISOString())
  if (count) console.log('app passwords revoked with member', JSON.stringify({ organizationId, userId, count }))
}

/** Hourly: removes app passwords revoked over 30 days ago. */
export async function appPasswordsHourly(env: Pick<Env, 'DB'>): Promise<void> {
  const purged = await db.purge(env.DB, new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString())
  if (purged) console.log('app passwords purged', purged)
}
