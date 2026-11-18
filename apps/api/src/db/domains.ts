// domains table: customer domains, mirrored from Stalwart x:Domain objects.

export type DomainRow = {
  id: string
  organization_id: string
  name: string
  stalwart_id: string
  status: 'pending' | 'verified'
  /** Where its mail lives (migration 0038): Stalwart, moving (MX on its way to SES), or the mailbox store. */
  mail_path: 'stalwart' | 'switching' | 'store'
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

/** Domains SES hasn't verified yet (or that were never registered), a random sample so none is starved. */
export async function listSesUnverified(db: D1Database, limit: number): Promise<DomainRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM domains WHERE ses_status IS NULL OR ses_status != 'verified' ORDER BY RANDOM() LIMIT ?")
    .bind(limit)
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

/**
 * Domains whose addresses all deliver to store-held mailboxes (at least one), and domains with addresses on both
 * sides. Stalwart must send mail for the first kind out to their MX (mailserver/stalwart/routing.ts).
 */
export async function storeHeldNames(db: D1Database): Promise<{ held: string[]; mixed: string[] }> {
  const { results } = await db
    .prepare(
      `SELECT d.name AS name,
              SUM(CASE WHEN m.backend = 'store' THEN 1 ELSE 0 END) AS store,
              SUM(CASE WHEN m.backend != 'store' THEN 1 ELSE 0 END) AS other
         FROM domains d JOIN addresses a ON a.domain_id = d.id JOIN mailboxes m ON m.id = a.mailbox_id
        GROUP BY d.id HAVING store > 0`,
    )
    .all<{ name: string; store: number; other: number }>()
  return { held: results.filter((r) => r.other === 0).map((r) => r.name), mixed: results.filter((r) => r.other > 0).map((r) => r.name) }
}

/** Where the mail of the domain an address is on lives (null for an address xstate doesn't have). */
export async function pathOfAddress(db: D1Database, address: string): Promise<DomainRow['mail_path'] | null> {
  return (
    (await db
      .prepare('SELECT d.mail_path AS p FROM addresses a JOIN domains d ON d.id = a.domain_id WHERE a.address = ?')
      .bind(address.toLowerCase())
      .first<'stalwart' | 'switching' | 'store'>('p')) ?? null
  )
}
