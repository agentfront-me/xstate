// invitations table: the open invitation of each invited member. See migrations/0013_invitations.sql.

export type InvitationRow = {
  member_id: string
  organization_id: string
  token_hash: string
  invited_by: string | null
  sent_at: string | null
  expires_at: string
  created_at: string
}

/** Creates the member's invitation, or replaces its token (sending again invalidates the old link). */
export function upsert(
  db: D1Database,
  i: { memberId: string; organizationId: string; tokenHash: string; invitedBy: string; sentAt: string | null; expiresAt: string; now: string },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO invitations (member_id, organization_id, token_hash, invited_by, sent_at, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (member_id) DO UPDATE SET token_hash = excluded.token_hash, invited_by = excluded.invited_by,
         sent_at = excluded.sent_at, expires_at = excluded.expires_at`,
    )
    .bind(i.memberId, i.organizationId, i.tokenHash, i.invitedBy, i.sentAt, i.expiresAt, i.now)
}

export function markSent(db: D1Database, memberId: string, sentAt: string): D1PreparedStatement {
  return db.prepare('UPDATE invitations SET sent_at = ? WHERE member_id = ?').bind(sentAt, memberId)
}

export type InvitationView = InvitationRow & {
  email: string
  name: string | null
  has_password: number
  user_id: string
  role: string
  organization_name: string
  invited_by_name: string | null
}

/** The invitation behind a link, with who it's for and the organization. */
export function findByTokenHash(db: D1Database, tokenHash: string): Promise<InvitationView | null> {
  return db
    .prepare(
      `SELECT i.*, u.email, u.name, u.password_hash IS NOT NULL AS has_password, u.id AS user_id, m.role,
              o.name AS organization_name, ib.name AS invited_by_name
       FROM invitations i
       JOIN members m ON m.id = i.member_id
       JOIN users u ON u.id = m.user_id
       JOIN organizations o ON o.id = i.organization_id
       LEFT JOIN users ib ON ib.id = i.invited_by
       WHERE i.token_hash = ?`,
    )
    .bind(tokenHash)
    .first<InvitationView>()
}

export function remove(db: D1Database, memberId: string): D1PreparedStatement {
  return db.prepare('DELETE FROM invitations WHERE member_id = ?').bind(memberId)
}
