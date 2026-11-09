// members table: people in an organization, their role and permissions.

export type Role = 'owner' | 'admin' | 'member'
/** 'invited' until the person accepts their invitation (db/invitations.ts). Only 'active' members can act. */
export type MemberStatus = 'invited' | 'active'
export type OrgPermission = 'domains.create' | 'domains.delete' | 'members.manage' | 'audience.manage'
export type DomainAccess = 'read' | 'manage'
/** Stored as JSONB in members.permissions. `domains['*']` applies to every domain in the organization. */
export type Permissions = { org: OrgPermission[]; domains: Record<string, DomainAccess> }

export type Member = { id: string; role: Role; permissions: Permissions }

/** The user's active membership in the organization. Invited members don't count until they accept. */
export async function find(db: D1Database, organizationId: string, userId: string): Promise<Member | null> {
  const row = await db
    .prepare(
      `SELECT id, role, json(permissions) AS permissions FROM members
       WHERE organization_id = ? AND user_id = ? AND status = 'active'`,
    )
    .bind(organizationId, userId)
    .first<{ id: string; role: Role; permissions: string }>()
  if (!row) return null
  const permissions = JSON.parse(row.permissions) as Partial<Permissions>
  return { id: row.id, role: row.role, permissions: { org: permissions.org ?? [], domains: permissions.domains ?? {} } }
}

/** The organizations a user is an active member of, with their membership in each. */
export async function listForUser(db: D1Database, userId: string) {
  const { results } = await db
    .prepare(
      `SELECT m.id AS member_id, m.role, o.id AS organization_id, o.name AS organization_name
       FROM members m JOIN organizations o ON o.id = m.organization_id
       WHERE m.user_id = ? AND m.status = 'active' ORDER BY o.created_at`,
    )
    .bind(userId)
    .all<{ member_id: string; role: Role; organization_id: string; organization_name: string }>()
  return results
}

export type MemberRow = {
  id: string
  organization_id: string
  user_id: string
  role: Role
  status: MemberStatus
  name: string | null
  email: string
  created_at: string
  /** From the open invitation, for invited members. */
  invited_by_name: string | null
  sent_at: string | null
  expires_at: string | null
}

const MEMBER_SELECT = `
  SELECT m.id, m.organization_id, m.user_id, m.role, m.status, u.name, u.email, m.created_at,
         ib.name AS invited_by_name, i.sent_at, i.expires_at
  FROM members m
  JOIN users u ON u.id = m.user_id
  LEFT JOIN invitations i ON i.member_id = m.id
  LEFT JOIN users ib ON ib.id = i.invited_by`

/** Everyone in the organization, invited or active: owner first, then by when they joined. */
export async function listForOrg(db: D1Database, organizationId: string): Promise<MemberRow[]> {
  const { results } = await db
    .prepare(`${MEMBER_SELECT} WHERE m.organization_id = ? ORDER BY m.role = 'owner' DESC, m.created_at`)
    .bind(organizationId)
    .all<MemberRow>()
  return results
}

export function findById(db: D1Database, memberId: string): Promise<MemberRow | null> {
  return db.prepare(`${MEMBER_SELECT} WHERE m.id = ?`).bind(memberId).first<MemberRow>()
}

/** The user's membership in the organization, invited or active. */
export function findByUser(db: D1Database, organizationId: string, userId: string): Promise<MemberRow | null> {
  return db.prepare(`${MEMBER_SELECT} WHERE m.organization_id = ? AND m.user_id = ?`).bind(organizationId, userId).first<MemberRow>()
}

export function insert(
  db: D1Database,
  member: { id: string; organizationId: string; userId: string; role: Role; status?: MemberStatus; now: string },
): D1PreparedStatement {
  return db
    .prepare('INSERT INTO members (id, organization_id, user_id, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(member.id, member.organizationId, member.userId, member.role, member.status ?? 'active', member.now, member.now)
}

/** Any membership, invited or active: invited members can already own mailboxes and be given access. */
export async function exists(db: D1Database, memberId: string, organizationId: string): Promise<boolean> {
  return !!(await db.prepare('SELECT 1 FROM members WHERE id = ? AND organization_id = ?').bind(memberId, organizationId).first())
}

export function setRole(db: D1Database, memberId: string, role: Exclude<Role, 'owner'>, now: string): D1PreparedStatement {
  return db.prepare("UPDATE members SET role = ?, updated_at = ? WHERE id = ? AND role != 'owner'").bind(role, now, memberId)
}

export function activate(db: D1Database, memberId: string, now: string): D1PreparedStatement {
  return db.prepare("UPDATE members SET status = 'active', updated_at = ? WHERE id = ?").bind(now, memberId)
}

/** Removes a membership (never the owner's). Their own My Files go with it (trigger in 0006_storage.sql). */
export function remove(db: D1Database, memberId: string): D1PreparedStatement {
  return db.prepare("DELETE FROM members WHERE id = ? AND role != 'owner'").bind(memberId)
}

export function setPermissions(db: D1Database, memberId: string, permissions: Permissions, now: string): D1PreparedStatement {
  return db
    .prepare('UPDATE members SET permissions = jsonb(?), updated_at = ? WHERE id = ?')
    .bind(JSON.stringify(permissions), now, memberId)
}

/** Drops a deleted domain's key from every member's permissions.domains. */
export function removeDomainFromPermissions(db: D1Database, organizationId: string, domainId: string): D1PreparedStatement {
  return db
    .prepare('UPDATE members SET permissions = jsonb_remove(permissions, ?) WHERE organization_id = ?')
    .bind(`$.domains."${domainId}"`, organizationId)
}
