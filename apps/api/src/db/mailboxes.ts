// mailboxes table. Reads join the primary address.

export type MailboxKind = 'personal' | 'shared' | 'agent'
export type StoreMode = 'off' | 'shadow' | 'read'
export type MailBackend = 'stalwart' | 'store'

/** A mailbox with its primary address and a JSON array of alias addresses. */
export type MailboxRow = {
  id: string
  organization_id: string
  kind: MailboxKind
  display_name: string | null
  quota_bytes: number | null
  stalwart_id: string
  /**
   * Left from the move off Stalwart (dropped in phase 5c); nothing reads it.
   */
  store_mode: StoreMode
  /** 1 to also copy each raw message into the organization's bucket and record where its attachments sit. */
  store_raw: number
  /**
   * Always 'store' now (docs/mailbox-store-plan.md); 'stalwart' is from before the move. Dropped in phase 5c.
   */
  backend: MailBackend
  created_at: string
  updated_at: string
  address: string
  domain_id: string
  aliases: string
}

const SELECT = `
  SELECT m.id, m.organization_id, m.kind, m.display_name, m.quota_bytes, m.stalwart_id, m.store_mode, m.store_raw, m.backend, m.created_at, m.updated_at,
         a.address, a.domain_id,
         (SELECT json_group_array(x.address) FROM addresses x WHERE x.mailbox_id = m.id AND x.is_primary = 0) AS aliases
  FROM mailboxes m JOIN addresses a ON a.mailbox_id = m.id AND a.is_primary = 1`

export function find(db: D1Database, id: string): Promise<MailboxRow | null> {
  return db.prepare(`${SELECT} WHERE m.id = ?`).bind(id).first<MailboxRow>()
}

export type ListFilter = {
  /** Limit to mailboxes on these domains or that this member has access to. Omit for every mailbox. */
  visibleTo?: { domainIds: string[]; memberId: string }
  domainId?: string
  kind?: MailboxKind
}

export async function list(db: D1Database, organizationId: string, filter: ListFilter = {}): Promise<MailboxRow[]> {
  const where = ['m.organization_id = ?']
  const params: unknown[] = [organizationId]
  if (filter.visibleTo) {
    where.push(`(a.domain_id IN (SELECT value FROM json_each(?))
      OR EXISTS (SELECT 1 FROM mailbox_access ma WHERE ma.mailbox_id = m.id AND ma.member_id = ?))`)
    params.push(JSON.stringify(filter.visibleTo.domainIds), filter.visibleTo.memberId)
  }
  if (filter.domainId) {
    where.push('a.domain_id = ?')
    params.push(filter.domainId)
  }
  if (filter.kind) {
    where.push('m.kind = ?')
    params.push(filter.kind)
  }
  const { results } = await db
    .prepare(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY a.address`)
    .bind(...params)
    .all<MailboxRow>()
  return results
}

export function insert(
  db: D1Database,
  mailbox: {
    id: string
    organizationId: string
    kind: MailboxKind
    displayName: string | null
    quotaBytes: number | null
    stalwartId: string
    createdBy: string
    now: string
    /** 'store' for a mailbox on a domain whose mail the store holds (phase 4b); 'stalwart' otherwise. */
    backend?: 'stalwart' | 'store'
  },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO mailboxes (id, organization_id, kind, display_name, quota_bytes, stalwart_id, created_by, created_at, updated_at, backend)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      mailbox.id,
      mailbox.organizationId,
      mailbox.kind,
      mailbox.displayName,
      mailbox.quotaBytes,
      mailbox.stalwartId,
      mailbox.createdBy,
      mailbox.now,
      mailbox.now,
      mailbox.backend ?? 'stalwart',
    )
}

/** Updates the given fields; at least one must be set. */
export function update(
  db: D1Database,
  id: string,
  changes: { displayName?: string | null; quotaBytes?: number | null },
  now: string,
): D1PreparedStatement {
  const sets: string[] = []
  const params: unknown[] = []
  if (changes.displayName !== undefined) {
    sets.push('display_name = ?')
    params.push(changes.displayName)
  }
  if (changes.quotaBytes !== undefined) {
    sets.push('quota_bytes = ?')
    params.push(changes.quotaBytes)
  }
  return db.prepare(`UPDATE mailboxes SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).bind(...params, now, id)
}

/** Deletes the mailbox; its addresses and access rows go with it (ON DELETE CASCADE). */
export function remove(db: D1Database, id: string): D1PreparedStatement {
  return db.prepare('DELETE FROM mailboxes WHERE id = ?').bind(id)
}

/** Mailboxes whose mail the store holds (backend = 'store'), for jobs that look after them. */
export async function heldByStore(db: D1Database): Promise<{ id: string; organization_id: string }[]> {
  const { results } = await db.prepare(`SELECT id, organization_id FROM mailboxes WHERE backend = 'store'`).all<{ id: string; organization_id: string }>()
  return results
}
