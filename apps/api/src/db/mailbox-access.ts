// mailbox_access table: which members can open which mailboxes.

export type AccessLevel = 'owner' | 'full' | 'read'

export function find(db: D1Database, mailboxId: string, memberId: string) {
  return db
    .prepare('SELECT access, created_at FROM mailbox_access WHERE mailbox_id = ? AND member_id = ?')
    .bind(mailboxId, memberId)
    .first<{ access: AccessLevel; created_at: string }>()
}

/** Everyone with access to a mailbox, with their user id, oldest first. */
export async function list(db: D1Database, mailboxId: string) {
  const { results } = await db
    .prepare(
      `SELECT ma.member_id, mb.user_id, ma.access FROM mailbox_access ma
       JOIN members mb ON mb.id = ma.member_id WHERE ma.mailbox_id = ? ORDER BY ma.created_at`,
    )
    .bind(mailboxId)
    .all<{ member_id: string; user_id: string; access: AccessLevel }>()
  return results
}

/** The member's access to every mailbox they have a row for, keyed by mailbox id. */
/**
 * The users to tell when the mailbox's mail changes (live updates, phone alerts): everyone with access except
 * members who are suspended or haven't accepted their invite.
 */
export async function listToNotify(db: D1Database, mailboxId: string) {
  const { results } = await db
    .prepare(
      `SELECT ma.member_id, mb.user_id, ma.access FROM mailbox_access ma
       JOIN members mb ON mb.id = ma.member_id
       WHERE ma.mailbox_id = ? AND mb.status = 'active' AND mb.suspended_at IS NULL ORDER BY ma.created_at`,
    )
    .bind(mailboxId)
    .all<{ member_id: string; user_id: string; access: AccessLevel }>()
  return results
}

export async function forMember(db: D1Database, memberId: string): Promise<Map<string, AccessLevel>> {
  const { results } = await db
    .prepare('SELECT mailbox_id, access FROM mailbox_access WHERE member_id = ?')
    .bind(memberId)
    .all<{ mailbox_id: string; access: AccessLevel }>()
  return new Map(results.map((r) => [r.mailbox_id, r.access]))
}

export async function memberIds(db: D1Database, mailboxId: string): Promise<string[]> {
  const { results } = await db
    .prepare('SELECT member_id FROM mailbox_access WHERE mailbox_id = ?')
    .bind(mailboxId)
    .all<{ member_id: string }>()
  return results.map((r) => r.member_id)
}

/** Adds access; does nothing if the member already has access (check `meta.changes`). */
export function insert(
  db: D1Database,
  row: { mailboxId: string; memberId: string; access: AccessLevel; createdAt: string },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO mailbox_access (mailbox_id, member_id, access, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (mailbox_id, member_id) DO NOTHING`,
    )
    .bind(row.mailboxId, row.memberId, row.access, row.createdAt)
}

export function remove(db: D1Database, mailboxId: string, memberId: string): D1PreparedStatement {
  return db.prepare('DELETE FROM mailbox_access WHERE mailbox_id = ? AND member_id = ?').bind(mailboxId, memberId)
}
