// domains table: customer domains, mirrored from Stalwart x:Domain objects.

export type DomainRow = {
  id: string
  organization_id: string
  name: string
  stalwart_id: string
  status: 'pending' | 'verified'
  enabled: number
  verified_at: string | null
  ses_status: 'pending' | 'verified' | 'failed' | null
  /** JSON array of Easy DKIM tokens. */
  ses_dkim_tokens: string | null
  /** Random; the domain's ownership TXT record is xstate-verification=<token>. */
  ownership_token: string | null
  /** When ownership was proven: the TXT record, or the mail records. */
  owned_at: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

export function find(db: D1Database, id: string): Promise<DomainRow | null> {
  return db.prepare('SELECT * FROM domains WHERE id = ?').bind(id).first<DomainRow>()
}

export async function nameTaken(db: D1Database, name: string): Promise<boolean> {
  return !!(await db.prepare('SELECT 1 FROM domains WHERE name = ?').bind(name).first())
}

export async function listByOrganization(db: D1Database, organizationId: string): Promise<DomainRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM domains WHERE organization_id = ? ORDER BY name')
    .bind(organizationId)
    .all<DomainRow>()
  return results
}

export function insert(
  db: D1Database,
  domain: { id: string; organizationId: string; name: string; stalwartId: string; createdBy: string; now: string },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO domains (id, organization_id, name, stalwart_id, created_by, created_at, updated_at, ownership_token)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(domain.id, domain.organizationId, domain.name, domain.stalwartId, domain.createdBy, domain.now, domain.now, crypto.randomUUID().replaceAll('-', ''))
}

export function setEnabled(db: D1Database, id: string, enabled: boolean, now: string): D1PreparedStatement {
  return db.prepare('UPDATE domains SET enabled = ?, updated_at = ? WHERE id = ?').bind(enabled ? 1 : 0, now, id)
}

export function setVerified(db: D1Database, id: string, now: string): D1PreparedStatement {
  // Mail records found prove ownership too.
  return db
    .prepare("UPDATE domains SET status = 'verified', verified_at = ?, owned_at = COALESCE(owned_at, ?), updated_at = ? WHERE id = ?")
    .bind(now, now, now, id)
}

export function setOwned(db: D1Database, id: string, now: string): D1PreparedStatement {
  return db.prepare('UPDATE domains SET owned_at = COALESCE(owned_at, ?), updated_at = ? WHERE id = ?').bind(now, now, id)
}

export function setSes(db: D1Database, id: string, ses: { status: string; dkimTokens: string[] }, now: string): D1PreparedStatement {
  return db
    .prepare('UPDATE domains SET ses_status = ?, ses_dkim_tokens = ?, updated_at = ? WHERE id = ?')
    .bind(ses.status, JSON.stringify(ses.dkimTokens), now, id)
}

export function remove(db: D1Database, id: string): D1PreparedStatement {
  return db.prepare('DELETE FROM domains WHERE id = ?').bind(id)
}
