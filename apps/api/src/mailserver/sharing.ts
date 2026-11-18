// Shared mailbox access, in D1: who can open a shared mailbox, and whether they can only read it.

import * as mailboxAccessDb from '../db/mailbox-access'
import { mailboxContext, requireMemberInOrg } from './access'
import { EmailError } from './errors'
import type { Actor, EmailEnv, MailboxAccessEntry } from './types'

export async function listMailboxAccess(env: EmailEnv, actor: Actor, mailboxId: string): Promise<MailboxAccessEntry[]> {
  const { mailbox } = await mailboxContext(env, actor, mailboxId, 'read')
  const rows = await mailboxAccessDb.list(env.DB, mailbox.id)
  return rows.map((r) => ({ memberId: r.member_id, userId: r.user_id, access: r.access }))
}

/**
 * Lets a member open a shared mailbox. `read` lets them read but not send, move or change anything. Granting again
 * with another level changes it.
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
  await requireMemberInOrg(env, memberId, mailbox.organization_id)

  const existing = await mailboxAccessDb.find(env.DB, mailbox.id, memberId)
  if (existing) {
    if (existing.access === 'owner') throw new EmailError('owner_access', "A mailbox owner's access can't be changed")
    if (existing.access !== access) {
      await env.DB.prepare('UPDATE mailbox_access SET access = ? WHERE mailbox_id = ? AND member_id = ?').bind(access, mailbox.id, memberId).run()
    }
    return
  }
  await mailboxAccessDb.insert(env.DB, { mailboxId: mailbox.id, memberId, access, createdAt: new Date().toISOString() }).run()
}

export async function revokeMailboxAccess(env: EmailEnv, actor: Actor, mailboxId: string, memberId: string): Promise<void> {
  const { mailbox } = await mailboxContext(env, actor, mailboxId, 'manage')
  const row = await mailboxAccessDb.find(env.DB, mailbox.id, memberId)
  if (!row) return
  if (row.access === 'owner') throw new EmailError('owner_access', "A mailbox owner's access cannot be revoked")

  await mailboxAccessDb.remove(env.DB, mailbox.id, memberId).run()
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
}
