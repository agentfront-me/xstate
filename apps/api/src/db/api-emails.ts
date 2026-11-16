// api_emails and api_email_recipients tables: the send log of POST /v1/emails. See migrations/0033_api_emails.sql.

import type { RecipientStatus } from '../emails/rules.ts'

export type ApiEmailRow = {
  id: string
  organization_id: string
  mailbox_id: string | null
  token_id: string | null
  user_id: string | null
  from_email: string
  from_name: string | null
  subject: string
  /** JSON object. */
  tags: string
  saved_to_sent: number
  message_id: string
  idempotency_key: string | null
  request_hash: string | null
  created_at: string
  /** JSON array of { address, type, status, detail, updated_at }, in the order they were given. */
  recipients: string
}

export type RecipientRow = { address: string; type: 'to' | 'cc' | 'bcc'; status: RecipientStatus; detail: string | null; updated_at: string }

const SELECT = `
  SELECT e.*, (
    SELECT json_group_array(json_object('address', r.address, 'type', r.type, 'status', r.status, 'detail', r.detail, 'updated_at', r.updated_at))
    FROM (SELECT * FROM api_email_recipients x WHERE x.email_id = e.id ORDER BY x.rowid) r
  ) AS recipients
  FROM api_emails e`

export function find(db: D1Database, id: string): Promise<ApiEmailRow | null> {
  return db.prepare(`${SELECT} WHERE e.id = ?`).bind(id).first<ApiEmailRow>()
}

export function findByIdempotencyKey(db: D1Database, tokenId: string, key: string): Promise<ApiEmailRow | null> {
  return db.prepare(`${SELECT} WHERE e.token_id = ? AND e.idempotency_key = ?`).bind(tokenId, key).first<ApiEmailRow>()
}

/** Frees an Idempotency-Key whose 24 hours are over, so it can be used for a new message. */
export async function forgetIdempotencyKey(db: D1Database, id: string): Promise<void> {
  await db.prepare('UPDATE api_emails SET idempotency_key = NULL, request_hash = NULL WHERE id = ?').bind(id).run()
}

/**
 * Records a message before it is sent, every recipient `queued` or `suppressed`. Throws on a second message with the
 * same token and Idempotency-Key (the unique index), which is how two retries at the same moment are told apart.
 */
export async function insert(
  db: D1Database,
  email: {
    id: string
    organizationId: string
    mailboxId: string
    tokenId: string
    userId: string
    from: { email: string; name: string | null }
    subject: string
    tags: Record<string, string>
    savedToSent: boolean
    messageId: string
    idempotencyKey: string | null
    requestHash: string | null
    recipients: { address: string; type: 'to' | 'cc' | 'bcc'; status: RecipientStatus; detail: string | null }[]
    now: string
  },
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `INSERT INTO api_emails (id, organization_id, mailbox_id, token_id, user_id, from_email, from_name, subject, tags, saved_to_sent,
           message_id, idempotency_key, request_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        email.id,
        email.organizationId,
        email.mailboxId,
        email.tokenId,
        email.userId,
        email.from.email,
        email.from.name,
        email.subject,
        JSON.stringify(email.tags),
        +email.savedToSent,
        email.messageId,
        email.idempotencyKey,
        email.requestHash,
        email.now,
      ),
    ...email.recipients.map((r) =>
      db
        .prepare('INSERT INTO api_email_recipients (email_id, address, type, status, detail, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(email.id, r.address, r.type, r.status, r.detail, email.now),
    ),
  ])
}

/** The send failed: nothing was sent, so nothing is logged and the Idempotency-Key is free for the retry. */
export async function remove(db: D1Database, id: string): Promise<void> {
  await db.prepare('DELETE FROM api_emails WHERE id = ?').bind(id).run()
}

/** The message is on its way: queued recipients become `sent`, or `delivered` for addresses on xstate itself. */
export async function markSent(db: D1Database, id: string, delivered: readonly string[], now: string): Promise<void> {
  await db
    .prepare(
      `UPDATE api_email_recipients
       SET status = CASE WHEN address IN (SELECT value FROM json_each(?1)) THEN 'delivered' ELSE 'sent' END, updated_at = ?2
       WHERE email_id = ?3 AND status = 'queued'`,
    )
    .bind(JSON.stringify(delivered), now, id)
    .run()
}

export type ListFilter = {
  organizationId: string
  userId: string
  mailboxIds: readonly string[]
  limit: number
  /** created_at and id of the last row of the page before. */
  after?: { createdAt: string; id: string }
  status?: RecipientStatus
  from?: string
  tags?: Record<string, string>
}

/** Messages this person sent through the API from these mailboxes, newest first. Returns one more than `limit` when there are more. */
export async function list(db: D1Database, f: ListFilter): Promise<ApiEmailRow[]> {
  const where = ['e.organization_id = ?', 'e.user_id = ?', 'e.mailbox_id IN (SELECT value FROM json_each(?))']
  const params: unknown[] = [f.organizationId, f.userId, JSON.stringify(f.mailboxIds)]
  if (f.after) {
    where.push('(e.created_at < ? OR (e.created_at = ? AND e.id < ?))')
    params.push(f.after.createdAt, f.after.createdAt, f.after.id)
  }
  if (f.status) {
    where.push('EXISTS (SELECT 1 FROM api_email_recipients r WHERE r.email_id = e.id AND r.status = ?)')
    params.push(f.status)
  }
  if (f.from) {
    where.push('e.from_email = ?')
    params.push(f.from)
  }
  // Tag names are checked against TAG_KEY (letters, digits, _ and -) before they get here.
  for (const [name, value] of Object.entries(f.tags ?? {})) {
    where.push(`json_extract(e.tags, '$."${name}"') = ?`)
    params.push(value)
  }
  const { results } = await db
    .prepare(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY e.created_at DESC, e.id DESC LIMIT ?`)
    .bind(...params, f.limit + 1)
    .all<ApiEmailRow>()
  return results
}

/**
 * The recipient row a delivery event is about: by Message-ID when the event carries it, otherwise the newest
 * message from that sender to that address that is still waiting to hear (the last few days).
 */
export async function findRecipientForEvent(
  db: D1Database,
  event: { messageId: string | null; sender: string; recipient: string; since: string },
): Promise<{ email_id: string; address: string; status: RecipientStatus } | null> {
  if (event.messageId) {
    const row = await db
      .prepare(
        `SELECT r.email_id, r.address, r.status FROM api_email_recipients r JOIN api_emails e ON e.id = r.email_id
         WHERE e.message_id = ? AND r.address = ?`,
      )
      .bind(event.messageId, event.recipient)
      .first<{ email_id: string; address: string; status: RecipientStatus }>()
    if (row) return row
  }
  return db
    .prepare(
      `SELECT r.email_id, r.address, r.status FROM api_email_recipients r JOIN api_emails e ON e.id = r.email_id
       WHERE e.from_email = ? AND r.address = ? AND e.created_at >= ? AND r.status IN ('sent', 'delivered')
       ORDER BY e.created_at DESC LIMIT 1`,
    )
    .bind(event.sender, event.recipient, event.since)
    .first<{ email_id: string; address: string; status: RecipientStatus }>()
}

export async function setRecipientStatus(
  db: D1Database,
  r: { emailId: string; address: string; status: RecipientStatus; detail: string | null; now: string },
): Promise<void> {
  await db
    .prepare('UPDATE api_email_recipients SET status = ?, detail = ?, updated_at = ? WHERE email_id = ? AND address = ?')
    .bind(r.status, r.detail, r.now, r.emailId, r.address)
    .run()
}

/** Removes messages sent before `before`. Their recipients go with them. */
export async function purge(db: D1Database, before: string): Promise<number> {
  const result = await db.prepare('DELETE FROM api_emails WHERE created_at < ?').bind(before).run()
  return result.meta.changes ?? 0
}
