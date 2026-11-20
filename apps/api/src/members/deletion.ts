// Deleting a member, restorable for 30 days (docs/members-plan.md, phase 4).
//
// Deleting suspends them at once (members/security.ts) and pauses the agents they made or published. What happens to
// their mailbox is chosen now:
// - 'shared': it becomes a shared mailbox straight away, which the chosen members can open (personal mailboxes are
//   readable only by their owner, see mailserver/access.ts mailAccess). Mail to their addresses keeps arriving.
//   Restoring makes it personal again. Only for mailboxes on the new mail system: on the current mail
//   server a personal mailbox can't become a shared one.
// - 'delete': the mailbox and all its mail are deleted when the deletion finishes.
// Until then "Restore" undoes it all except the paused agents. The hourly job (membersHourly) finishes deletions:
// their My Files move into a folder in the deleter's My Files, their agents go to the deleter, then the membership
// (and the account, when it's in no other organization) is removed.

import { revokeTokensOfMember } from '../auth/api-tokens'
import { revokeAppPasswordsOfMember } from '../auth/app-passwords'
import type { Actor } from '../auth/types'
import * as mailboxAccessDb from '../db/mailbox-access'
import * as membersDb from '../db/members'
import { ApiError } from '../errors'
import { deleteMailbox } from '../mailserver'
import { isAdmin, requireOrgPermission } from '../mailserver/access'
import { signOutUser } from './security'
import { getMember, type OrgMember } from './service'

export const DELETE_DAYS = 30

type Personal = { id: string; backend: 'stalwart' | 'store' }

/**
 * Their own mailboxes: personal, or already turned shared by a pending deletion (they still hold the owner row).
 * Usually one, but people set up before one mailbox could have addresses on several domains may have one per domain.
 */
async function personalMailboxes(env: Env, memberId: string): Promise<Personal[]> {
  const { results } = await env.DB.prepare(
    `SELECT mb.id, mb.backend FROM mailbox_access ma JOIN mailboxes mb ON mb.id = ma.mailbox_id
     WHERE ma.member_id = ? AND ma.access = 'owner' AND mb.kind IN ('personal', 'shared')`,
  )
    .bind(memberId)
    .all<Personal>()
  return results
}

export async function deleteMember(
  env: Env,
  actor: Actor,
  memberId: string,
  input: { mail: 'shared' | 'delete'; shareWith: string[] },
): Promise<OrgMember> {
  const target = await membersDb.findById(env.DB, memberId)
  const me = target && (await membersDb.find(env.DB, target.organization_id, actor.userId))
  if (!target || !me) throw new ApiError('member_not_found', 'Member not found', 404)
  requireOrgPermission(me, 'members.manage')
  if (target.user_id === actor.userId) throw new ApiError('forbidden', "You can't delete yourself", 403)
  if (target.role === 'owner') throw new ApiError('forbidden', "The owner can't be deleted", 403)
  if (target.role === 'admin' && !isAdmin(me)) throw new ApiError('forbidden', 'Only owners and admins can delete an admin', 403)
  if (target.status !== 'active') throw new ApiError('not_active', "They haven't joined yet. Cancel their invite instead.", 409)
  const pending = await env.DB.prepare('SELECT delete_after FROM members WHERE id = ?').bind(memberId).first<{ delete_after: string | null }>()
  if (pending?.delete_after) throw new ApiError('already_deleting', 'This member is already being deleted', 409)

  const mailboxes = await personalMailboxes(env, memberId)
  let shareWith: string[] = []
  if (mailboxes.length && input.mail === 'shared') {
    if (mailboxes.some((m) => m.backend !== 'store')) {
      throw new ApiError(
        'shared_needs_new_mail_system',
        "One of their mailboxes is on the current mail server, where it can't become a shared mailbox. Choose to delete their mail, or wait until its domain has moved.",
        409,
      )
    }
    shareWith = [...new Set(input.shareWith)].filter((id) => id !== memberId)
    if (!shareWith.length) throw new ApiError('share_with_required', 'Choose who gets access to their mailbox')
    const { results } = await env.DB.prepare(
      `SELECT id FROM members WHERE organization_id = ? AND status = 'active' AND suspended_at IS NULL AND id IN (SELECT value FROM json_each(?))`,
    )
      .bind(target.organization_id, JSON.stringify(shareWith))
      .all<{ id: string }>()
    if (results.length !== shareWith.length) throw new ApiError('member_not_found', 'One of the people chosen is no longer in the organization', 404)
  }

  const now = new Date()
  const iso = now.toISOString()
  const after = new Date(now.getTime() + DELETE_DAYS * 86_400_000).toISOString()
  // Only grants they didn't already have, so restoring takes away exactly these: [mailbox id, member id] pairs.
  const added: [string, string][] = []
  for (const mb of mailboxes) {
    for (const id of shareWith) if (!(await mailboxAccessDb.find(env.DB, mb.id, id))) added.push([mb.id, id])
  }
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE members SET suspended_at = COALESCE(suspended_at, ?), delete_after = ?, delete_mail = ?, delete_shared_with = ?,
         deleted_by = ?, updated_at = ? WHERE id = ?`,
    ).bind(iso, after, mailboxes.length ? input.mail : null, JSON.stringify(added), me.id, iso, memberId),
    ...signOutUser(env, target.user_id, iso),
    ...added.map(([mailboxId, id]) => mailboxAccessDb.insert(env.DB, { mailboxId, memberId: id, access: 'full', createdAt: iso })),
    ...(input.mail === 'shared'
      ? mailboxes.map((mb) => env.DB.prepare("UPDATE mailboxes SET kind = 'shared', updated_at = ? WHERE id = ?").bind(iso, mb.id))
      : []),
    // Their agents act with their access, which is gone: paused until someone else takes them on.
    env.DB.prepare(
      `UPDATE agents SET status = 'paused', updated_at = ? WHERE organization_id = ? AND status = 'active' AND (created_by = ?
         OR id IN (SELECT v.agent_id FROM agent_versions v JOIN agents a ON a.id = v.agent_id
                   WHERE v.version = a.published_version AND v.published_by = ?))`,
    ).bind(iso, target.organization_id, target.user_id, target.user_id),
  ])
  console.log('member deletion started', JSON.stringify({ by: actor.userId, memberId, organizationId: target.organization_id, mail: input.mail }))
  return getMember(env, actor, memberId)
}

/** Undoes a deletion that hasn't finished: access back, and the mailbox grants made for it taken away. */
export async function cancelDeletion(env: Env, memberId: string): Promise<D1PreparedStatement[]> {
  const row = await env.DB.prepare('SELECT delete_shared_with, delete_mail FROM members WHERE id = ? AND delete_after IS NOT NULL')
    .bind(memberId)
    .first<{ delete_shared_with: string | null; delete_mail: string | null }>()
  if (!row) return []
  const mailboxes = await personalMailboxes(env, memberId)
  // [mailbox id, member id] pairs; deletions started before that format stored member ids only (their one mailbox).
  const granted = (JSON.parse(row.delete_shared_with ?? '[]') as (string | [string, string])[]).flatMap((g) =>
    typeof g === 'string' ? (mailboxes[0] ? [[mailboxes[0].id, g] as [string, string]] : []) : [g],
  )
  const now = new Date().toISOString()
  return [
    env.DB.prepare('UPDATE members SET delete_after = NULL, delete_mail = NULL, delete_shared_with = NULL, deleted_by = NULL WHERE id = ?').bind(memberId),
    ...granted.map(([mailboxId, id]) => mailboxAccessDb.remove(env.DB, mailboxId, id)),
    ...(row.delete_mail === 'shared'
      ? mailboxes.map((mb) => env.DB.prepare("UPDATE mailboxes SET kind = 'personal', updated_at = ? WHERE id = ?").bind(now, mb.id))
      : []),
  ]
}

// ---------------------------------------------------------------------------------------------------------------
// Finishing (hourly)

export async function membersHourly(env: Env): Promise<void> {
  const { results } = await env.DB.prepare(
    "SELECT id FROM members WHERE delete_after IS NOT NULL AND delete_after <= ? AND role != 'owner' LIMIT 20",
  )
    .bind(new Date().toISOString())
    .all<{ id: string }>()
  for (const { id } of results) {
    await finishDeletion(env, id).catch((err) => console.error(`member deletion of ${id} failed`, err))
  }
}

export async function finishDeletion(env: Env, memberId: string): Promise<void> {
  const target = await env.DB.prepare(
    `SELECT m.id, m.organization_id, m.user_id, m.delete_mail, m.deleted_by, u.name, u.email, o.owner_id
     FROM members m JOIN users u ON u.id = m.user_id JOIN organizations o ON o.id = m.organization_id
     WHERE m.id = ? AND m.delete_after IS NOT NULL`,
  )
    .bind(memberId)
    .first<{ id: string; organization_id: string; user_id: string; delete_mail: 'shared' | 'delete' | null; deleted_by: string | null; name: string | null; email: string; owner_id: string }>()
  if (!target) return
  // Files and agents go to whoever deleted them, or to the owner if that person has left since.
  const heir = await env.DB.prepare(
    `SELECT id, user_id FROM members WHERE organization_id = ? AND status = 'active' AND delete_after IS NULL
       AND (id = ? OR (user_id = ? AND role = 'owner')) ORDER BY id = ? DESC LIMIT 1`,
  )
    .bind(target.organization_id, target.deleted_by, target.owner_id, target.deleted_by)
    .first<{ id: string; user_id: string }>()
  if (!heir) throw new Error('no member to hand files to')
  const now = new Date().toISOString()

  // The mailboxes first: if deleting one fails, the membership is still there and the next hour tries again.
  for (const mailbox of await personalMailboxes(env, memberId)) {
    if (target.delete_mail === 'delete') {
      await deleteMailbox(env, { userId: target.owner_id }, mailbox.id)
    } else {
      await env.DB.batch([
        env.DB.prepare("UPDATE mailboxes SET kind = 'shared', updated_at = ? WHERE id = ?").bind(now, mailbox.id),
        mailboxAccessDb.remove(env.DB, mailbox.id, memberId),
      ])
    }
  }

  // My Files: into a folder at the top of the heir's My Files, so nothing clashes with their own names.
  const tops = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM storage_items WHERE owner_member_id = ? AND space = 'personal' AND parent_id IS NULL",
  )
    .bind(memberId)
    .first<{ n: number }>()
  const moves: D1PreparedStatement[] = []
  if (tops?.n) {
    const folderId = crypto.randomUUID()
    const base = `From ${target.name || target.email}`
    const taken = await env.DB.prepare(
      `SELECT 1 FROM storage_items WHERE organization_id = ? AND space = 'personal' AND parent_id IS NULL AND owner_member_id = ?
         AND trashed_at IS NULL AND name = ? COLLATE NOCASE`,
    )
      .bind(target.organization_id, heir.id, base)
      .first()
    const name = taken ? `${base} (${now.slice(0, 10)})` : base
    moves.push(
      env.DB.prepare(
        `INSERT INTO storage_items (id, organization_id, space, parent_id, kind, name, owner_member_id, created_by, created_at, updated_by, updated_at)
         VALUES (?, ?, 'personal', NULL, 'folder', ?, ?, ?, ?, ?, ?)`,
      ).bind(folderId, target.organization_id, name, heir.id, heir.user_id, now, heir.user_id, now),
      env.DB.prepare("UPDATE storage_items SET parent_id = ? WHERE owner_member_id = ? AND space = 'personal' AND parent_id IS NULL").bind(folderId, memberId),
      env.DB.prepare("UPDATE storage_items SET owner_member_id = ? WHERE owner_member_id = ? AND space = 'personal'").bind(heir.id, memberId),
    )
  }
  await env.DB.batch([
    ...moves,
    env.DB.prepare('UPDATE agents SET created_by = ?, updated_at = ? WHERE organization_id = ? AND created_by = ?').bind(heir.user_id, now, target.organization_id, target.user_id),
    membersDb.remove(env.DB, memberId),
    // Their account goes too unless they're in another organization.
    env.DB.prepare('DELETE FROM users WHERE id = ? AND NOT EXISTS (SELECT 1 FROM members WHERE user_id = ?)').bind(target.user_id, target.user_id),
  ])
  await revokeTokensOfMember(env, target.organization_id, { userId: target.user_id, name: target.name, email: target.email }, null).catch((err) =>
    console.error('revoking api tokens failed', err),
  )
  await revokeAppPasswordsOfMember(env, target.organization_id, target.user_id, null).catch((err) => console.error('revoking app passwords failed', err))
  console.log('member deleted', JSON.stringify({ memberId, organizationId: target.organization_id, mail: target.delete_mail }))
}
