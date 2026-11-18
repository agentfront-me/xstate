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

/**
 * The organization's own domains, and the display names of its active members and its mailboxes: what a received
 * message's sender is compared with, to catch someone using a colleague's name from outside (mailbox/spam.ts).
 */
export async function identity(db: D1Database, organizationId: string): Promise<{ domains: string[]; names: string[] }> {
  const [domains, names] = await db.batch([
    db.prepare('SELECT name FROM domains WHERE organization_id = ?').bind(organizationId),
    db
      .prepare(
        `SELECT u.name AS name FROM members m JOIN users u ON u.id = m.user_id
         WHERE m.organization_id = ? AND m.status = 'active' AND u.name IS NOT NULL AND u.name <> ''
         UNION SELECT display_name FROM mailboxes WHERE organization_id = ? AND display_name IS NOT NULL AND display_name <> ''`,
      )
      .bind(organizationId, organizationId),
  ])
  return {
    domains: (domains!.results as { name: string }[]).map((r) => r.name),
    names: (names!.results as { name: string }[]).map((r) => r.name),
  }
}
