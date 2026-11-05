import * as addressesDb from '../db/addresses'
import * as mailboxAccessDb from '../db/mailbox-access'
import * as mailboxesDb from '../db/mailboxes'
import { domainContext, isAdmin, loadMember, mailboxContext, requireAddressFree, requireMemberInOrg } from './access'
import { EmailError, withRollback } from './errors'
import { syncMemberGroups } from './sharing'
import * as stalwart from './stalwart/accounts'
import { toMailbox, type Actor, type EmailEnv, type Mailbox, type MailboxKind } from './types'
import { generatePassword, normalizeLocalPart, validatePassword, validateQuota } from './validation'

export type CreateMailboxInput = {
  kind: MailboxKind
  domainId: string
  localPart: string
  displayName?: string
  /** Generated for personal and agent mailboxes if omitted (returned once), not allowed for shared ones. */
  password?: string
  quotaBytes?: number | null
  /** The member a personal mailbox belongs to. */
  ownerMemberId?: string
}

/**
 * Creates a mailbox and its primary address. personal and agent mailboxes become Stalwart users that sign in
 * with a password; shared mailboxes become Stalwart groups that members open through their personal mailbox.
 * `password` in the result is set only when one was generated, and is not stored anywhere.
 */
export async function createMailbox(
  env: EmailEnv,
  actor: Actor,
  input: CreateMailboxInput,
): Promise<{ mailbox: Mailbox; password?: string }> {
  const { domain } = await domainContext(env, actor, input.domainId, 'manage')
  const localPart = normalizeLocalPart(input.localPart)
  const address = `${localPart}@${domain.name}`
  await requireAddressFree(env, address)

  let password = input.password
  let generated: string | undefined
  if (input.kind === 'shared') {
    if (password !== undefined) throw new EmailError('invalid_password', 'Shared mailboxes have no password')
    if (input.ownerMemberId) throw new EmailError('invalid_owner', 'Shared mailboxes have no owner; grant access instead')
  } else {
    // Onboarding creates the first personal mailbox without one: the owner reads mail in xstate and can set a
    // password later for other mail apps.
    if (password === undefined) password = generated = generatePassword()
    validatePassword(password)
  }
  if (input.ownerMemberId) {
    if (input.kind !== 'personal') throw new EmailError('invalid_owner', 'Only personal mailboxes have an owner')
    await requireMemberInOrg(env, input.ownerMemberId, domain.organization_id)
  }
  validateQuota(input.quotaBytes)

  const displayName = input.displayName ?? null
  const quotaBytes = input.quotaBytes ?? null
  const fields = { name: localPart, domainId: domain.stalwart_id, description: displayName, quotaBytes }
  const stalwartId =
    input.kind === 'shared' ? await stalwart.createGroup(env, fields) : await stalwart.createUser(env, { ...fields, password: password! })

  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  const organizationId = domain.organization_id
  const writes = [
    mailboxesDb.insert(env.DB, { id, organizationId, kind: input.kind, displayName, quotaBytes, stalwartId, createdBy: actor.userId, now }),
    addressesDb.insert(env.DB, { organizationId, mailboxId: id, domainId: domain.id, localPart, address, isPrimary: true, now }),
  ]
  if (input.ownerMemberId) {
    writes.push(mailboxAccessDb.insert(env.DB, { mailboxId: id, memberId: input.ownerMemberId, access: 'owner', createdAt: now }))
  }
  await withRollback(
    () => env.DB.batch(writes),
    () => stalwart.destroyAccount(env, stalwartId),
  )

  // Give the new personal mailbox the shared mailboxes its owner already has access to.
  if (input.ownerMemberId) await syncMemberGroups(env, input.ownerMemberId)

  return { mailbox: toMailbox((await mailboxesDb.find(env.DB, id))!), ...(generated && { password: generated }) }
}

export async function getMailbox(env: EmailEnv, actor: Actor, mailboxId: string): Promise<Mailbox> {
  const { mailbox } = await mailboxContext(env, actor, mailboxId, 'read')
  return toMailbox(mailbox)
}

/** Mailboxes the actor can see: those on domains they can read, plus any they have been given access to. */
export async function listMailboxes(
  env: EmailEnv,
  actor: Actor,
  organizationId: string,
  filter: { domainId?: string; kind?: MailboxKind } = {},
): Promise<Mailbox[]> {
  const member = await loadMember(env, organizationId, actor.userId)
  const seesAll = isAdmin(member) || !!member.permissions.domains['*']
  const rows = await mailboxesDb.list(env.DB, organizationId, {
    ...filter,
    ...(!seesAll && { visibleTo: { domainIds: Object.keys(member.permissions.domains), memberId: member.id } }),
  })
  return rows.map(toMailbox)
}

/** Changes the display name (mailbox owner or domain manager) or the storage quota (domain manager only). */
export async function updateMailbox(
  env: EmailEnv,
  actor: Actor,
  mailboxId: string,
  changes: { displayName?: string | null; quotaBytes?: number | null },
): Promise<Mailbox> {
  const { mailbox } = await mailboxContext(env, actor, mailboxId, changes.quotaBytes !== undefined ? 'manage' : 'owner')
  validateQuota(changes.quotaBytes)
  if (changes.displayName === undefined && changes.quotaBytes === undefined) return toMailbox(mailbox)

  const stalwartChanges = { description: changes.displayName, quotaBytes: changes.quotaBytes }
  const undo = {
    description: changes.displayName === undefined ? undefined : mailbox.display_name,
    quotaBytes: changes.quotaBytes === undefined ? undefined : mailbox.quota_bytes,
  }
  await stalwart.updateAccount(env, mailbox.stalwart_id, stalwartChanges)
  await withRollback(
    () => mailboxesDb.update(env.DB, mailbox.id, changes, new Date().toISOString()).run(),
    () => stalwart.updateAccount(env, mailbox.stalwart_id, undo),
  )
  return toMailbox((await mailboxesDb.find(env.DB, mailbox.id))!)
}

/** Resets the password of a personal or agent mailbox. Also signs it out of its OAuth apps. */
export async function setMailboxPassword(env: EmailEnv, actor: Actor, mailboxId: string, password: string): Promise<void> {
  const { mailbox } = await mailboxContext(env, actor, mailboxId, 'owner')
  if (mailbox.kind === 'shared') throw new EmailError('invalid_password', 'Shared mailboxes have no password')
  validatePassword(password)
  await stalwart.setPassword(env, mailbox.stalwart_id, password)
}

/** Permanently deletes a mailbox, its addresses and all of its mail. The /email API should confirm first. */
export async function deleteMailbox(env: EmailEnv, actor: Actor, mailboxId: string): Promise<void> {
  const { mailbox } = await mailboxContext(env, actor, mailboxId, 'manage')
  const memberIds = await mailboxAccessDb.memberIds(env.DB, mailbox.id)

  await stalwart.destroyAccount(env, mailbox.stalwart_id)
  await mailboxesDb.remove(env.DB, mailbox.id).run()

  if (mailbox.kind === 'shared') await Promise.all(memberIds.map((memberId) => syncMemberGroups(env, memberId)))
}
