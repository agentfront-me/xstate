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
 * `read` lets them read but not send, move or change anything. Only on xstate's new mail system: on the current mail
 * server group membership can't be made read-only. Granting again with another level changes it.
 */
export async function grantMailboxAccess(
  env: EmailEnv,
  actor: Actor,
  mailboxId: string,
  memberId: string,
  access: 'full' | 'read' = 'full',
): Promise<void> {
  const { mailbox } = await mailboxContext(env, actor, mailboxId, 'manage')
  if (mailbox.kind !== 'shared') throw new EmailError('not_shared', 'Access can only be granted to shared mailboxes')
  if (access === 'read' && mailbox.backend !== 'store') {
    throw new EmailError('read_needs_new_mail_system', "Read-only access works once this mailbox's domain has moved to xstate's new mail system", 409)
  }
  await requireMemberInOrg(env, memberId, mailbox.organization_id)

  const existing = await mailboxAccessDb.find(env.DB, mailbox.id, memberId)
  if (existing) {
    if (existing.access === 'owner') throw new EmailError('owner_access', "A mailbox owner's access can't be changed")
    if (existing.access !== access) {
      await env.DB.prepare('UPDATE mailbox_access SET access = ? WHERE mailbox_id = ? AND member_id = ?').bind(access, mailbox.id, memberId).run()
    }
    return
  }
  const { meta } = await mailboxAccessDb
    .insert(env.DB, { mailboxId: mailbox.id, memberId, access, createdAt: new Date().toISOString() })
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

/**
 * Gives a personal mailbox to another member of the organization: they become its owner and its previous owner loses
 * access. For a mailbox made for someone before they joined, or one an admin set up under the wrong person. Its
 * mail goes with it, so the person giving it should be sure: the new owner reads everything in it.
 */
export async function giveMailbox(env: EmailEnv, actor: Actor, mailboxId: string, memberId: string): Promise<void> {
  const { mailbox } = await mailboxContext(env, actor, mailboxId, 'manage')
  if (mailbox.kind !== 'personal') throw new EmailError('not_personal', 'Only personal mailboxes have an owner to change')
  await requireMemberInOrg(env, memberId, mailbox.organization_id)
  const target = await env.DB.prepare('SELECT delete_after FROM members WHERE id = ?').bind(memberId).first<{ delete_after: string | null }>()
  if (target?.delete_after) throw new EmailError('member_deleting', 'That member is being deleted', 409)
  const owner = await env.DB.prepare("SELECT member_id FROM mailbox_access WHERE mailbox_id = ? AND access = 'owner'")
    .bind(mailbox.id)
    .first<{ member_id: string }>()
  if (owner?.member_id === memberId) return

  await env.DB.batch([
    // Any access they had to it already is replaced by owning it.
    mailboxAccessDb.remove(env.DB, mailbox.id, memberId),
    owner
      ? env.DB.prepare("UPDATE mailbox_access SET member_id = ? WHERE mailbox_id = ? AND access = 'owner'").bind(memberId, mailbox.id)
      : mailboxAccessDb.insert(env.DB, { mailboxId: mailbox.id, memberId, access: 'owner', createdAt: new Date().toISOString() }),
  ])
  console.log('mailbox given', JSON.stringify({ by: actor.userId, mailboxId: mailbox.id, from: owner?.member_id ?? null, to: memberId }))
  // Their shared mailboxes follow them into Stalwart, for mailboxes still there (no-op on the new mail system).
  await syncMemberGroups(env, memberId).catch((err) => console.error('give mailbox: group sync failed', err))
  if (owner) await syncMemberGroups(env, owner.member_id).catch((err) => console.error('give mailbox: group sync failed', err))
}
