// Shared mailbox access. A shared mailbox is a Stalwart group; members open it through their personal mailbox.

import * as mailboxAccessDb from '../db/mailbox-access'
import { mailboxContext, requireMemberInOrg } from './access'
import { EmailError, withRollback } from './errors'
import * as stalwart from './stalwart/accounts'
import type { Actor, EmailEnv, MailboxAccessEntry } from './types'

export async function listMailboxAccess(env: EmailEnv, actor: Actor, mailboxId: string): Promise<MailboxAccessEntry[]> {
  const { mailbox } = await mailboxContext(env, actor, mailboxId, 'read')
  const rows = await mailboxAccessDb.list(env.DB, mailbox.id)
  return rows.map((r) => ({ memberId: r.member_id, userId: r.user_id, access: r.access }))
}

/**
 * Lets a member open a shared mailbox. In Stalwart this makes each of the member's personal mailboxes a member
 * of the shared mailbox's group, so it shows up in their mail client (as shared folders in IMAP, a separate
 * account in JMAP). A member with no personal mailbox yet gets it when one is created.
 *
 * Only full access exists for now: Stalwart group membership can't be made read-only.
 */
export async function grantMailboxAccess(env: EmailEnv, actor: Actor, mailboxId: string, memberId: string): Promise<void> {
  const { mailbox } = await mailboxContext(env, actor, mailboxId, 'manage')
  if (mailbox.kind !== 'shared') throw new EmailError('not_shared', 'Access can only be granted to shared mailboxes')
  await requireMemberInOrg(env, memberId, mailbox.organization_id)

  const { meta } = await mailboxAccessDb
    .insert(env.DB, { mailboxId: mailbox.id, memberId, access: 'full', createdAt: new Date().toISOString() })
    .run()
  if (!meta.changes) return

  await withRollback(
    () => syncMemberGroups(env, memberId),
    () => mailboxAccessDb.remove(env.DB, mailbox.id, memberId).run(),
  )
}

export async function revokeMailboxAccess(env: EmailEnv, actor: Actor, mailboxId: string, memberId: string): Promise<void> {
  const { mailbox } = await mailboxContext(env, actor, mailboxId, 'manage')
  const row = await mailboxAccessDb.find(env.DB, mailbox.id, memberId)
  if (!row) return
  if (row.access === 'owner') throw new EmailError('owner_access', "A mailbox owner's access cannot be revoked")

  await mailboxAccessDb.remove(env.DB, mailbox.id, memberId).run()
  await withRollback(
    () => syncMemberGroups(env, memberId),
    () => mailboxAccessDb.insert(env.DB, { mailboxId: mailbox.id, memberId, access: row.access, createdAt: row.created_at }).run(),
  )
}

/** Sets each of the member's personal mailboxes in Stalwart to belong to exactly the shared mailboxes they can open. */
export async function syncMemberGroups(env: EmailEnv, memberId: string): Promise<void> {
  const { sharedGroups, personalMailboxes } = await mailboxAccessDb.stalwartIdsForMember(env.DB, memberId)
  for (const id of personalMailboxes) await stalwart.setMemberGroups(env, id, sharedGroups)
}
