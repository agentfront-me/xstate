// email_events and suppressions tables: bounces and complaints from Amazon SES. See migrations/0004_email_events.sql.

export type EmailEvent = {
  id: string
  organizationId: string | null
  mailboxId: string | null
  type: 'bounce' | 'complaint'
  subtype: string | null
  sender: string
  recipient: string
  detail: string | null
  sesMessageId: string | null
  createdAt: string
}

/** Records an event; a notification SNS delivers twice is ignored the second time. */
export function insertEvent(db: D1Database, e: EmailEvent): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO email_events (id, organization_id, mailbox_id, type, subtype, sender, recipient, detail, ses_message_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
    )
    .bind(e.id, e.organizationId, e.mailboxId, e.type, e.subtype, e.sender, e.recipient, e.detail, e.sesMessageId, e.createdAt)
}

export function suppress(
  db: D1Database,
  s: { address: string; organizationId: string; reason: 'bounce' | 'complaint'; detail: string | null; createdAt: string },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO suppressions (address, organization_id, reason, detail, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (address, organization_id) DO UPDATE SET reason = excluded.reason, detail = excluded.detail, created_at = excluded.created_at`,
    )
    .bind(s.address.toLowerCase(), s.organizationId, s.reason, s.detail, s.createdAt)
}

/** Which of these addresses this organization must not send to. */
export async function suppressedFor(db: D1Database, organizationId: string, addresses: string[]) {
  if (!addresses.length) return []
  const { results } = await db
    .prepare(
      `SELECT address, reason FROM suppressions
       WHERE address IN (SELECT lower(value) FROM json_each(?)) AND organization_id IN ('', ?)`,
    )
    .bind(JSON.stringify(addresses), organizationId)
    .all<{ address: string; reason: 'bounce' | 'complaint' }>()
  return results
}
