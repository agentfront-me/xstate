// organizations table: workspaces that own domains and mailboxes.

export function insert(
  db: D1Database,
  organization: { id: string; name: string; ownerId: string; now: string },
): D1PreparedStatement {
  return db
    .prepare('INSERT INTO organizations (id, name, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .bind(organization.id, organization.name, organization.ownerId, organization.now, organization.now)
}
