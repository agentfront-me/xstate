// organizations table: workspaces that own domains and mailboxes.

export function insert(
  db: D1Database,
  organization: { id: string; name: string; ownerId: string; now: string },
): D1PreparedStatement {
  return db
    .prepare('INSERT INTO organizations (id, name, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .bind(organization.id, organization.name, organization.ownerId, organization.now, organization.now)
}

/** The organization's R2 bucket name, or null if it hasn't been created yet. */
export async function getBucket(db: D1Database, organizationId: string): Promise<string | null> {
  const row = await db.prepare('SELECT r2_bucket FROM organizations WHERE id = ?').bind(organizationId).first<{ r2_bucket: string | null }>()
  return row?.r2_bucket ?? null
}

export function setBucket(db: D1Database, organizationId: string, bucket: string): D1PreparedStatement {
  return db
    .prepare('UPDATE organizations SET r2_bucket = ?, updated_at = ? WHERE id = ?')
    .bind(bucket, new Date().toISOString(), organizationId)
}

/** Organizations that don't have a bucket yet, for the backfill. */
export async function listWithoutBucket(db: D1Database): Promise<string[]> {
  const { results } = await db.prepare('SELECT id FROM organizations WHERE r2_bucket IS NULL ORDER BY created_at').all<{ id: string }>()
  return results.map((r) => r.id)
}
