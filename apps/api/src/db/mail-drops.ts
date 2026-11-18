// mail_drops: received mail that reached no mailbox, for the delivery log (mailbox/delivery-log.ts). Kept 30 days.

export type MailDropRow = { id: string; organization_id: string | null; ses_id: string; at: string; sender: string | null; recipient: string; reason: string }

/** Records a drop; a retried job records it once (the id is the SES message and the recipient). */
export function insert(db: D1Database, d: Omit<MailDropRow, 'id'>): D1PreparedStatement {
  return db
    .prepare('INSERT OR IGNORE INTO mail_drops (id, organization_id, ses_id, at, sender, recipient, reason) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(`${d.ses_id}:${d.recipient}`, d.organization_id, d.ses_id, d.at, d.sender, d.recipient, d.reason)
}

/** The organization that has an address's domain, for a drop to an address that doesn't exist; null if none does. */
export async function organizationOfAddress(db: D1Database, address: string): Promise<string | null> {
  const domain = address.slice(address.lastIndexOf('@') + 1).toLowerCase()
  return (await db.prepare('SELECT organization_id FROM domains WHERE name = ?').bind(domain).first<string>('organization_id')) ?? null
}

/** An organization's drops, newest first: all, or those matching an address (part of it) or an SES message id. */
export async function list(db: D1Database, organizationId: string, query: string | null, limit: number): Promise<MailDropRow[]> {
  const q = query?.trim().toLowerCase() || null
  const { results } = await db
    .prepare(
      `SELECT * FROM mail_drops WHERE organization_id = ?1
         AND (?2 IS NULL OR ses_id = ?2 OR instr(recipient, ?2) > 0 OR instr(coalesce(sender, ''), ?2) > 0)
       ORDER BY at DESC LIMIT ?3`,
    )
    .bind(organizationId, q, limit)
    .all<MailDropRow>()
  return results
}

export function purge(db: D1Database, before: string): D1PreparedStatement {
  return db.prepare('DELETE FROM mail_drops WHERE at < ?').bind(before)
}
