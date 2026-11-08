// send_log, delivery_counts, sending_suspensions and sending_blocks. See migrations/0011_sending_limits.sql.

export type Usage = { mailboxHour: number; mailboxDay: number; orgHour: number; orgDay: number }

export type SuspensionRow = {
  id: string
  organization_id: string
  mailbox_id: string | null
  reason: 'bounces' | 'complaints' | 'manual'
  detail: string | null
  created_at: string
}

export function logSend(
  db: D1Database,
  row: { id: string; organizationId: string; mailboxId: string; recipients: number; createdAt: string },
): D1PreparedStatement {
  return db
    .prepare('INSERT INTO send_log (id, organization_id, mailbox_id, recipients, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(row.id, row.organizationId, row.mailboxId, row.recipients, row.createdAt)
}

export function unlogSend(db: D1Database, id: string): D1PreparedStatement {
  return db.prepare('DELETE FROM send_log WHERE id = ?').bind(id)
}

/** Outside recipients sent by the mailbox and its organization since `hourAgo` and since `dayAgo`. */
export function usage(db: D1Database, organizationId: string, mailboxId: string | null, hourAgo: string, dayAgo: string) {
  return db
    .prepare(
      `SELECT coalesce(sum(CASE WHEN mailbox_id = ?1 AND created_at >= ?3 THEN recipients END), 0) AS mailboxHour,
              coalesce(sum(CASE WHEN mailbox_id = ?1 THEN recipients END), 0) AS mailboxDay,
              coalesce(sum(CASE WHEN created_at >= ?3 THEN recipients END), 0) AS orgHour,
              coalesce(sum(recipients), 0) AS orgDay
       FROM send_log WHERE organization_id = ?2 AND created_at >= ?4`,
    )
    .bind(mailboxId, organizationId, hourAgo, dayAgo)
}

/** Active suspensions that stop this mailbox: its own, or its organization's. */
export function activeFor(db: D1Database, organizationId: string, mailboxId: string | null) {
  return db
    .prepare(
      `SELECT id, organization_id, mailbox_id, reason, detail, created_at FROM sending_suspensions
       WHERE organization_id = ? AND lifted_at IS NULL AND (mailbox_id IS NULL OR mailbox_id = ?)`,
    )
    .bind(organizationId, mailboxId)
}

export async function listActive(db: D1Database, organizationId: string): Promise<SuspensionRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, organization_id, mailbox_id, reason, detail, created_at FROM sending_suspensions
       WHERE organization_id = ? AND lifted_at IS NULL ORDER BY created_at`,
    )
    .bind(organizationId)
    .all<SuspensionRow>()
  return results
}

/** Adds a suspension; one already active for the same mailbox or organization wins. Returns whether it was added. */
export async function suspend(
  db: D1Database,
  s: { id: string; organizationId: string; mailboxId: string | null; reason: SuspensionRow['reason']; detail: string; createdAt: string },
): Promise<boolean> {
  const res = await db
    .prepare(
      `INSERT OR IGNORE INTO sending_suspensions (id, organization_id, mailbox_id, reason, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(s.id, s.organizationId, s.mailboxId, s.reason, s.detail, s.createdAt)
    .run()
  return res.meta.changes > 0
}

export function addDelivered(
  db: D1Database,
  row: { mailboxId: string; organizationId: string; day: string; count: number },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO delivery_counts (mailbox_id, organization_id, day, delivered) VALUES (?, ?, ?, ?)
       ON CONFLICT (mailbox_id, day) DO UPDATE SET delivered = delivered + excluded.delivered`,
    )
    .bind(row.mailboxId, row.organizationId, row.day, row.count)
}

export type Reputation = { delivered: number; bounces: number; complaints: number }

/**
 * Delivered recipients, permanent bounces and complaints since `since` ('YYYY-MM-DD…'), for one mailbox, or for the
 * whole organization when mailboxId is null.
 */
export async function reputation(db: D1Database, organizationId: string, mailboxId: string | null, since: string): Promise<Reputation> {
  const scope = mailboxId ? 'mailbox_id = ?2' : 'organization_id = ?1'
  const row = await db
    .prepare(
      `SELECT
         (SELECT coalesce(sum(delivered), 0) FROM delivery_counts WHERE ${scope} AND day >= substr(?3, 1, 10)) AS delivered,
         (SELECT count(*) FROM email_events WHERE ${scope} AND type = 'bounce' AND subtype = 'Permanent' AND created_at >= ?3) AS bounces,
         (SELECT count(*) FROM email_events WHERE ${scope} AND type = 'complaint' AND created_at >= ?3) AS complaints`,
    )
    .bind(organizationId, mailboxId, since)
    .first<Reputation>()
  return row ?? { delivered: 0, bounces: 0, complaints: 0 }
}

/** Stalwart accounts that should have sending turned off: user mailboxes under an active suspension. */
export async function accountsToBlock(db: D1Database): Promise<{ stalwart_id: string; organization_id: string }[]> {
  const { results } = await db
    .prepare(
      `SELECT m.stalwart_id, m.organization_id FROM mailboxes m
       WHERE m.kind != 'shared' AND EXISTS (
         SELECT 1 FROM sending_suspensions s
         WHERE s.organization_id = m.organization_id AND s.lifted_at IS NULL AND (s.mailbox_id IS NULL OR s.mailbox_id = m.id))`,
    )
    .all<{ stalwart_id: string; organization_id: string }>()
  return results
}

export async function blockedAccounts(db: D1Database): Promise<string[]> {
  const { results } = await db.prepare('SELECT stalwart_id FROM sending_blocks').all<{ stalwart_id: string }>()
  return results.map((r) => r.stalwart_id)
}

export function addBlock(db: D1Database, stalwartId: string, organizationId: string, createdAt: string): D1PreparedStatement {
  return db
    .prepare('INSERT OR IGNORE INTO sending_blocks (stalwart_id, organization_id, created_at) VALUES (?, ?, ?)')
    .bind(stalwartId, organizationId, createdAt)
}

export function removeBlock(db: D1Database, stalwartId: string): D1PreparedStatement {
  return db.prepare('DELETE FROM sending_blocks WHERE stalwart_id = ?').bind(stalwartId)
}

/** Drops send_log rows older than `before` and delivery counts older than `beforeDay`. */
export function prune(db: D1Database, before: string, beforeDay: string) {
  return db.batch([
    db.prepare('DELETE FROM send_log WHERE created_at < ?').bind(before),
    db.prepare('DELETE FROM delivery_counts WHERE day < ?').bind(beforeDay),
  ])
}
