// Personal API tokens (docs/transactional-api-plan.md): how a person's own server calls the API as them. Settings →
// API keys → Personal Tokens creates and revokes them; requireToken (auth/middleware.ts) checks them on /v1/emails.
//
// A token belongs to one person in one organization and is limited to the mailboxes picked for it. It can never do
// more than its owner: every request checks the owner's access as it is at that moment, so a mailbox taken away in
// the app is out of the token's reach on the next call. With no mailbox left it stops working (and works again if
// access comes back); when its owner leaves the organization it is revoked for good.
//
// Only the SHA-256 hash is stored. The token is returned once, by createToken, and can't be shown again.

import * as db from '../db/api-tokens'
import type { TokenRow } from '../db/api-tokens'
import * as mailboxesDb from '../db/mailboxes'
import * as membersDb from '../db/members'
import * as usersDb from '../db/users'
import { ApiError } from '../errors'
import { isAdmin, loadMember, writableMailboxes } from '../mailserver/access'
import { paragraph, systemMailHtml } from '../mailserver/mail-html'
import { sendSystemEmail, type SystemMailEnv } from '../mailserver/system-mail'
import {
  EXPIRY_NOTICE_DAYS,
  MAX_TOKENS,
  TOKEN_SCOPES,
  expiryDate,
  hashToken,
  isToken,
  maskToken,
  newToken,
  tokenState,
  type ExpiresIn,
  type TokenScope,
  type TokenState,
} from './api-token-rules.ts'
import type { Actor } from './types'
import { track } from '../analytics/events'

export type Token = {
  id: string
  name: string
  /** `xst_live_…` and the last 4 characters. */
  masked: string
  scopes: string[]
  /** The mailboxes it was given. `usable` is false for one its owner can no longer send from. */
  mailboxes: { id: string; address: string; usable: boolean }[]
  state: TokenState
  person: { userId: string; name: string | null; email: string; you: boolean }
  createdAt: string
  lastUsedAt: string | null
  expiresAt: string | null
}

/** Who a request with a token acts as. */
export type TokenAuth = {
  actor: Actor
  token: { id: string; organizationId: string; userId: string; scopes: TokenScope[] }
}

/** What the emails about tokens need: far less than the whole environment, so the members service can call in. */
type TokenMailEnv = SystemMailEnv & Pick<Env, 'APP_URL'>

const DAY = 24 * 60 * 60 * 1000
const settingsUrl = (env: Pick<Env, 'APP_URL'>) => `${env.APP_URL.replace(/\/+$/, '')}/app/#/settings/api-keys`
const disabledError = () => new ApiError('api_tokens_disabled', 'API tokens are turned off for this organization', 403)
const notFound = () => new ApiError('token_not_found', 'Token not found', 404)

/** The ids of the mailboxes this person can send from, or none if they are no longer in the organization. */
async function writableIds(env: Env, organizationId: string, userId: string): Promise<Set<string>> {
  const rows = await writableMailboxes(env, { userId }, organizationId).catch((err) => {
    if (err instanceof ApiError && err.status === 404) return []
    throw err
  })
  return new Set(rows.map((m) => m.id))
}

function present(row: TokenRow, person: Token['person'], writable: Set<string>, addresses: Map<string, string>, now: Date): Token {
  const mailboxes = (JSON.parse(row.mailbox_ids) as string[]).flatMap((id) => {
    const address = addresses.get(id)
    return address ? [{ id, address, usable: writable.has(id) }] : []
  })
  return {
    id: row.id,
    name: row.name,
    masked: maskToken(row.last4),
    scopes: JSON.parse(row.scopes) as string[],
    mailboxes: mailboxes.sort((a, b) => a.address.localeCompare(b.address)),
    state: tokenState(row, mailboxes.filter((m) => m.usable).length, now),
    person,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
  }
}

async function presentOne(env: Env, actor: Actor, row: TokenRow): Promise<Token> {
  const [user, writable, mailboxes] = await Promise.all([
    usersDb.findById(env.DB, row.user_id),
    writableIds(env, row.organization_id, row.user_id),
    mailboxesDb.list(env.DB, row.organization_id),
  ])
  const person = { userId: row.user_id, name: user?.name ?? null, email: user?.email ?? '', you: row.user_id === actor.userId }
  return present(row, person, writable, new Map(mailboxes.map((m) => [m.id, m.address])), new Date())
}

// ---------------------------------------------------------------------------------------------------------------
// Settings → API keys → Personal Tokens

/**
 * The actor's tokens, or with `all` everyone's (owners and admins only). Also what the page needs to offer a new
 * one: whether tokens are on, and the mailboxes the actor can send from.
 */
export async function listTokens(env: Env, actor: Actor, organizationId: string, all: boolean) {
  const member = await loadMember(env, organizationId, actor.userId)
  const admin = isAdmin(member)
  if (all && !admin) throw new ApiError('forbidden', 'Only owners and admins can see everyone’s tokens', 403)

  const [rows, people, mailboxes, mine, disabled] = await Promise.all([
    db.list(env.DB, organizationId, all ? undefined : actor.userId),
    membersDb.listForOrg(env.DB, organizationId),
    mailboxesDb.list(env.DB, organizationId),
    writableMailboxes(env, actor, organizationId),
    db.tokensDisabled(env.DB, organizationId),
  ])
  const addresses = new Map(mailboxes.map((m) => [m.id, m.address]))
  const byUser = new Map(people.filter((p) => p.status === 'active').map((p) => [p.user_id, p]))
  const writable = new Map<string, Set<string>>([[actor.userId, new Set(mine.map((m) => m.id))]])
  for (const userId of new Set(rows.map((r) => r.user_id))) {
    if (!writable.has(userId)) writable.set(userId, await writableIds(env, organizationId, userId))
  }

  const now = new Date()
  const tokens = rows.flatMap((row) => {
    const p = byUser.get(row.user_id)
    // Its owner left: it was revoked then, and is only still here if that failed. Nothing to show.
    if (!p) return []
    const person = { userId: p.user_id, name: p.name, email: p.email, you: p.user_id === actor.userId }
    return [present(row, person, writable.get(row.user_id)!, addresses, now)]
  })
  // Yours first, then newest.
  tokens.sort((a, b) => Number(b.person.you) - Number(a.person.you) || b.createdAt.localeCompare(a.createdAt))
  return {
    tokens,
    enabled: !disabled,
    /** Owners and admins: may list everyone's, revoke anyone's and turn tokens on or off. */
    canManage: admin,
    mailboxes: mine.map((m) => ({ id: m.id, address: m.address, kind: m.kind })),
    limit: MAX_TOKENS,
  }
}

/** Checks the ids are mailboxes the actor can send from, and returns them without repeats. */
async function ownMailboxes(env: Env, actor: Actor, organizationId: string, mailboxIds: readonly string[]): Promise<string[]> {
  const ids = [...new Set(mailboxIds)]
  if (!ids.length) throw new ApiError('invalid_input', 'Choose at least one mailbox for the token')
  const writable = new Set((await writableMailboxes(env, actor, organizationId)).map((m) => m.id))
  const refused = ids.find((id) => !writable.has(id))
  if (refused) throw new ApiError('forbidden', `You can't send from mailbox ${refused}, so a token of yours can't either`, 403)
  return ids
}

/** Creates a token and returns it in full, this once. */
export async function createToken(
  env: Env,
  actor: Actor,
  organizationId: string,
  input: { name: string; mailboxIds: readonly string[]; expiresIn: ExpiresIn },
  waitUntil: (promise: Promise<unknown>) => void,
): Promise<{ token: Token; secret: string }> {
  await loadMember(env, organizationId, actor.userId)
  if (await db.tokensDisabled(env.DB, organizationId)) throw disabledError()
  const mailboxIds = await ownMailboxes(env, actor, organizationId, input.mailboxIds)
  const now = new Date()
  if ((await db.countLive(env.DB, organizationId, actor.userId, now.toISOString())) >= MAX_TOKENS) {
    throw new ApiError('token_limit_reached', `You have ${MAX_TOKENS} tokens already. Revoke one you no longer use first.`, 409)
  }

  const secret = newToken()
  const id = crypto.randomUUID()
  await db.insert(env.DB, {
    id,
    organizationId,
    userId: actor.userId,
    name: input.name,
    hash: await hashToken(secret),
    last4: secret.slice(-4),
    scopes: TOKEN_SCOPES,
    expiresAt: expiryDate(input.expiresIn, now),
    mailboxIds,
    now: now.toISOString(),
  })
  console.log('api token created', JSON.stringify({ tokenId: id, userId: actor.userId, organizationId, mailboxes: mailboxIds.length }))
  const row = (await db.find(env.DB, organizationId, id))!
  // There is no audit log yet: this email is how a token made from someone else's session gets noticed.
  waitUntil(emailCreated(env, row).catch((err) => console.error('api token email failed', err)))
  track(env, waitUntil, actor.userId, organizationId, 'API Token Created', { mailbox_count: mailboxIds.length, expires: input.expiresIn !== 'never' })
  return { token: await presentOne(env, actor, row), secret }
}

/** The actor's own live token, or 404: nobody else may change it, admins included. */
async function ownToken(env: Env, actor: Actor, organizationId: string, tokenId: string): Promise<TokenRow> {
  await loadMember(env, organizationId, actor.userId)
  const row = await db.find(env.DB, organizationId, tokenId)
  if (!row || row.revoked_at || row.user_id !== actor.userId) throw notFound()
  return row
}

export async function updateToken(
  env: Env,
  actor: Actor,
  organizationId: string,
  tokenId: string,
  input: { name?: string; mailboxIds?: readonly string[] },
): Promise<{ token: Token }> {
  const row = await ownToken(env, actor, organizationId, tokenId)
  if (input.mailboxIds) await db.setMailboxes(env.DB, row.id, await ownMailboxes(env, actor, organizationId, input.mailboxIds))
  if (input.name !== undefined) await db.rename(env.DB, row.id, input.name)
  return { token: await presentOne(env, actor, (await db.find(env.DB, organizationId, tokenId))!) }
}

/** Ends a token at once. Your own; owners and admins can revoke anyone's. */
export async function revokeToken(env: Env, actor: Actor, organizationId: string, tokenId: string): Promise<void> {
  const member = await loadMember(env, organizationId, actor.userId)
  const row = await db.find(env.DB, organizationId, tokenId)
  // Same answer for one that doesn't exist and one this person may not see.
  if (!row || row.revoked_at || (row.user_id !== actor.userId && !isAdmin(member))) throw notFound()
  await db.revoke(env.DB, row.id, actor.userId, new Date().toISOString())
  console.log('api token revoked', JSON.stringify({ tokenId: row.id, by: actor.userId, userId: row.user_id, organizationId }))
}

/** Turns personal tokens on or off for the whole organization. Off refuses every token; none is deleted. */
export async function setTokensEnabled(env: Env, actor: Actor, organizationId: string, enabled: boolean): Promise<{ enabled: boolean }> {
  const member = await loadMember(env, organizationId, actor.userId)
  if (!isAdmin(member)) throw new ApiError('forbidden', 'Only owners and admins can turn API tokens on or off', 403)
  await db.setTokensDisabled(env.DB, organizationId, !enabled)
  console.log('api tokens switched', JSON.stringify({ organizationId, enabled, by: actor.userId }))
  return { enabled }
}

// ---------------------------------------------------------------------------------------------------------------
// Checking a request

const invalid = () => new ApiError('invalid_token', 'The API token is missing, unknown, revoked or expired', 401)

/**
 * Who a bearer token acts as, or throws: 401 invalid_token, 403 api_tokens_disabled, 403 no_mailboxes. The actor is
 * limited to the token's mailboxes its owner can still send from, so the usual access checks do the rest.
 */
export async function authenticateToken(env: Env, bearer: string | undefined, waitUntil: (promise: Promise<unknown>) => void): Promise<TokenAuth> {
  if (!bearer || !isToken(bearer)) throw invalid()
  const row = await db.findByHash(env.DB, await hashToken(bearer))
  const now = new Date()
  if (!row || row.revoked_at || (row.expires_at && row.expires_at <= now.toISOString())) throw invalid()
  // Its owner left the organization. removeMember revokes their tokens; this covers any that slipped through.
  if (!(await membersDb.find(env.DB, row.organization_id, row.user_id))) throw invalid()
  if (await db.tokensDisabled(env.DB, row.organization_id)) throw disabledError()

  const writable = await writableIds(env, row.organization_id, row.user_id)
  const mailboxIds = (JSON.parse(row.mailbox_ids) as string[]).filter((id) => writable.has(id))
  if (!mailboxIds.length) {
    throw new ApiError('no_mailboxes', 'This token has no mailbox it can send from any more. Give it one in Settings → API keys.', 403)
  }
  waitUntil(db.touch(env.DB, row.id, now).catch((err) => console.error('api token touch failed', err)))
  return {
    actor: { userId: row.user_id, mailboxIds },
    token: { id: row.id, organizationId: row.organization_id, userId: row.user_id, scopes: JSON.parse(row.scopes) as TokenScope[] },
  }
}

// ---------------------------------------------------------------------------------------------------------------
// When a person leaves

/**
 * Revokes every token a person has in an organization, for good, and tells the owners and admins which integrations
 * just stopped. Called when a member is removed or leaves; best effort, so it never blocks the removal.
 */
export async function revokeTokensOfMember(
  env: TokenMailEnv,
  organizationId: string,
  person: { userId: string; name: string | null; email: string },
  by: string | null,
): Promise<void> {
  const names = await db.revokeForUser(env.DB, organizationId, person.userId, by, new Date().toISOString())
  if (!names.length) return
  console.log('api tokens revoked with member', JSON.stringify({ organizationId, userId: person.userId, count: names.length }))
  const who = person.name || person.email
  const lines = [
    `${who} is no longer in your organization, so their API tokens have stopped working: ${names.join(', ')}.`,
    'Anything that sent email with one of these tokens will now be refused. To keep it running, another member creates a token for the same mailbox and you put it in place of the old one.',
  ]
  const url = settingsUrl(env)
  const text = `${lines.join('\n\n')}\n\nOpen API keys:\n${url}\n`
  const html = systemMailHtml({ paragraphs: lines.map((l) => paragraph(l)), button: { text: 'Open API keys', url } })
  const subject = names.length === 1 ? `An API token stopped working: ${names[0]}` : `${names.length} API tokens stopped working`
  const admins = (await membersDb.listForOrg(env.DB, organizationId)).filter((m) => m.status === 'active' && (m.role === 'owner' || m.role === 'admin'))
  for (const admin of admins.slice(0, 20)) {
    await sendSystemEmail(env, { to: { name: admin.name, email: admin.email }, subject, text, html }).catch((err) => console.error('api token email failed', err))
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Emails to the owner, and the hourly upkeep

async function emailOwner(env: TokenMailEnv, userId: string, subject: string, lines: string[], footnote?: string): Promise<void> {
  const user = await usersDb.findById(env.DB, userId)
  if (!user) return
  const url = settingsUrl(env)
  const text = `${lines.join('\n\n')}\n\nOpen API keys:\n${url}\n${footnote ? `\n${footnote}\n` : ''}`
  const html = systemMailHtml({ paragraphs: lines.map((l) => paragraph(l)), button: { text: 'Open API keys', url }, footnote })
  await sendSystemEmail(env, { to: { name: user.name, email: user.email }, subject, text, html })
}

async function emailCreated(env: Env, row: TokenRow): Promise<void> {
  const addresses = new Map((await mailboxesDb.list(env.DB, row.organization_id)).map((m) => [m.id, m.address]))
  const from = (JSON.parse(row.mailbox_ids) as string[]).flatMap((id) => addresses.get(id) ?? []).join(', ')
  await emailOwner(
    env,
    row.user_id,
    `New API token: ${row.name}`,
    [`An API token named "${row.name}" was just created on your xstate account. It can send email from ${from}.`],
    'If this wasn’t you, revoke the token in Settings → API keys and change your password.',
  )
}

/** Hourly: the "ends in a week" email, once per token, and removal of tokens that ended over 30 days ago. */
export async function tokensHourly(env: Env): Promise<void> {
  const now = new Date()
  const soon = new Date(now.getTime() + EXPIRY_NOTICE_DAYS * DAY).toISOString()
  for (const token of await db.claimExpiring(env.DB, now.toISOString(), soon)) {
    const day = token.expires_at.slice(0, 10)
    await emailOwner(env, token.user_id, `Your API token "${token.name}" ends on ${day}`, [
      `Your API token "${token.name}" (${maskToken(token.last4)}) stops working on ${day}.`,
      'To keep your integration running, create a new token, put it in place of this one, then revoke the old one.',
    ]).catch((err) => console.error('api token expiry email failed', err))
  }
  const purged = await db.purge(env.DB, new Date(now.getTime() - 30 * DAY).toISOString())
  if (purged) console.log('api tokens purged', purged)
}
