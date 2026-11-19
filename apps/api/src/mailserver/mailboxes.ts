import * as addressesDb from '../db/addresses'
import { requireRoom } from '../limits'
import * as mailboxAccessDb from '../db/mailbox-access'
import * as mailboxesDb from '../db/mailboxes'
import { domainContext, isAdmin, loadMember, mailboxContext, requireAddressFree, requireMemberInOrg } from './access'
import { EmailError } from './errors'
import type { BucketEnv } from '../storage/buckets'
import { deleteMailboxFolder } from '../storage/files'
import { store } from '../mailbox/stub'
import { toMailbox, type Actor, type EmailEnv, type Mailbox, type MailboxKind } from './types'
import { normalizeLocalPart, validateQuota } from './validation'

export type CreateMailboxInput = {
  kind: MailboxKind
  domainId: string
  localPart: string
  displayName?: string
  quotaBytes?: number | null
  /** The member a personal mailbox belongs to. */
  ownerMemberId?: string
}

/**
 * Creates a mailbox and its primary address, in D1 only: its mail lives in the mailbox's own store
 * (docs/mailbox-store-plan.md). There is no password: mailboxes are read and sent from in xstate's apps and API.
 */
export async function createMailbox(env: EmailEnv, actor: Actor, input: CreateMailboxInput): Promise<{ mailbox: Mailbox }> {
  const { domain } = await domainContext(env, actor, input.domainId, 'manage')
  const localPart = normalizeLocalPart(input.localPart)
  const address = `${localPart}@${domain.name}`
  await requireAddressFree(env, address)
  // Plan limit (limits/): Free counts personal and shared mailboxes together. Agent mailboxes are free.
  if (input.kind === 'personal' || input.kind === 'shared') await requireRoom(env, domain.organization_id, 'mailboxes')

  if (input.kind === 'shared' && input.ownerMemberId) throw new EmailError('invalid_owner', 'Shared mailboxes have no owner; grant access instead')
  if (input.ownerMemberId) {
    if (input.kind !== 'personal') throw new EmailError('invalid_owner', 'Only personal mailboxes have an owner')
    await requireMemberInOrg(env, input.ownerMemberId, domain.organization_id)
  }
  validateQuota(input.quotaBytes)

  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  const organizationId = domain.organization_id
  const writes = [
    mailboxesDb.insert(env.DB, {
      id,
      organizationId,
      kind: input.kind,
      displayName: input.displayName ?? null,
      quotaBytes: input.quotaBytes ?? null,
      // The column is NOT NULL UNIQUE until the table rebuild in phase 5c; nothing reads it any more.
      stalwartId: `none:${id}`,
      createdBy: actor.userId,
      now,
      backend: 'store',
    }),
    addressesDb.insert(env.DB, { organizationId, mailboxId: id, domainId: domain.id, localPart, address, isPrimary: true, now }),
  ]
  if (input.ownerMemberId) {
    writes.push(mailboxAccessDb.insert(env.DB, { mailboxId: id, memberId: input.ownerMemberId, access: 'owner', createdAt: now }))
  }
  await env.DB.batch(writes)
  return { mailbox: toMailbox((await mailboxesDb.find(env.DB, id))!) }
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

  await mailboxesDb.update(env.DB, mailbox.id, changes, new Date().toISOString()).run()
  return toMailbox((await mailboxesDb.find(env.DB, mailbox.id))!)
}

/**
 * Permanently deletes a mailbox, its addresses, all of its mail and its folder of files in R2. The /email API
 * should confirm first.
 */
export async function deleteMailbox(env: EmailEnv & BucketEnv, actor: Actor, mailboxId: string): Promise<void> {
  const { mailbox } = await mailboxContext(env, actor, mailboxId, 'manage')
  // Before the row goes, since its files rows cascade with it. A failure here leaves files under the mailbox's
  // id in R2 rather than blocking the delete; nothing points at them any more.
  await deleteMailboxFolder(env, mailbox.organization_id, mailbox.id).catch((err) =>
    console.error(`storage: deleting R2 folder of mailbox ${mailbox.id} failed`, err),
  )
  // The mailbox's own store (mailbox/store.ts) goes with it. Its raw copies are inside the R2 folder deleted above.
  await store(env, mailbox.id)
    .then((stub) => stub.destroy())
    .catch((err) => console.error(`mailbox-store: deleting the store of mailbox ${mailbox.id} failed`, err))
  await mailboxesDb.remove(env.DB, mailbox.id).run()
}
