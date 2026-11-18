// addresses table: every address that delivers to a mailbox, primary and aliases.

export async function taken(db: D1Database, address: string): Promise<boolean> {
  return !!(await db.prepare('SELECT 1 FROM addresses WHERE address = ?').bind(address).first())
}

export async function countOnDomain(db: D1Database, domainId: string): Promise<number> {
  return (await db.prepare('SELECT count(*) AS n FROM addresses WHERE domain_id = ?').bind(domainId).first<number>('n')) ?? 0
}

export function insert(
  db: D1Database,
  address: {
    organizationId: string
    mailboxId: string
    domainId: string
    localPart: string
    address: string
    isPrimary: boolean
    now: string
  },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO addresses (id, organization_id, mailbox_id, domain_id, local_part, address, is_primary, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      address.organizationId,
      address.mailboxId,
      address.domainId,
      address.localPart,
      address.address,
      address.isPrimary ? 1 : 0,
      address.now,
    )
}

export function findOnMailbox(db: D1Database, mailboxId: string, address: string) {
  return db
    .prepare('SELECT id, is_primary FROM addresses WHERE mailbox_id = ? AND address = ?')
    .bind(mailboxId, address)
    .first<{ id: string; is_primary: number }>()
}

export function remove(db: D1Database, id: string): D1PreparedStatement {
  return db.prepare('DELETE FROM addresses WHERE id = ?').bind(id)
}

/** The mailbox and organization an address delivers to, or null if it isn't an xstate address. */
export function findByAddress(db: D1Database, address: string) {
  return db
    .prepare('SELECT mailbox_id, organization_id FROM addresses WHERE address = ?')
    .bind(address.toLowerCase())
    .first<{ mailbox_id: string; organization_id: string }>()
}

/** Every address of a mailbox (primary and aliases) with its domain. */
export async function listForMailbox(db: D1Database, mailboxId: string): Promise<{ address: string; domain_id: string; is_primary: number }[]> {
  const { results } = await db.prepare('SELECT address, domain_id, is_primary FROM addresses WHERE mailbox_id = ?').bind(mailboxId).all<{ address: string; domain_id: string; is_primary: number }>()
  return results
}
