// members table: people in an organization, their role and permissions.

export type Role = 'owner' | 'admin' | 'member'
export type OrgPermission = 'domains.create' | 'domains.delete' | 'members.manage'
export type DomainAccess = 'read' | 'manage'
/** Stored as JSONB in members.permissions. `domains['*']` applies to every domain in the organization. */
export type Permissions = { org: OrgPermission[]; domains: Record<string, DomainAccess> }

export type Member = { id: string; role: Role; permissions: Permissions }

export async function find(db: D1Database, organizationId: string, userId: string): Promise<Member | null> {
  const row = await db
    .prepare('SELECT id, role, json(permissions) AS permissions FROM members WHERE organization_id = ? AND user_id = ?')
    .bind(organizationId, userId)
    .first<{ id: string; role: Role; permissions: string }>()
  if (!row) return null
  const permissions = JSON.parse(row.permissions) as Partial<Permissions>
  return { id: row.id, role: row.role, permissions: { org: permissions.org ?? [], domains: permissions.domains ?? {} } }
}

/** The organizations a user belongs to, with their membership in each. */
export async function listForUser(db: D1Database, userId: string) {
  const { results } = await db
    .prepare(
      `SELECT m.id AS member_id, m.role, o.id AS organization_id, o.name AS organization_name
       FROM members m JOIN organizations o ON o.id = m.organization_id
       WHERE m.user_id = ? ORDER BY o.created_at`,
    )
    .bind(userId)
    .all<{ member_id: string; role: Role; organization_id: string; organization_name: string }>()
  return results
}

export function insert(
  db: D1Database,
  member: { id: string; organizationId: string; userId: string; role: Role; now: string },
): D1PreparedStatement {
  return db
    .prepare('INSERT INTO members (id, organization_id, user_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(member.id, member.organizationId, member.userId, member.role, member.now, member.now)
}

export async function exists(db: D1Database, memberId: string, organizationId: string): Promise<boolean> {
  return !!(await db.prepare('SELECT 1 FROM members WHERE id = ? AND organization_id = ?').bind(memberId, organizationId).first())
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
