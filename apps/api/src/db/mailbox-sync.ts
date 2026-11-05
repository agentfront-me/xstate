// mailbox_sync table: the last JMAP Email state whose changes have been copied for each mailbox.

export async function getState(db: D1Database, mailboxId: string): Promise<string | null> {
  const row = await db.prepare('SELECT email_state FROM mailbox_sync WHERE mailbox_id = ?').bind(mailboxId).first<{ email_state: string | null }>()
  return row?.email_state ?? null
}

export function saveState(db: D1Database, mailboxId: string, emailState: string, now: string): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO mailbox_sync (mailbox_id, email_state, synced_at) VALUES (?, ?, ?)
       ON CONFLICT (mailbox_id) DO UPDATE SET email_state = excluded.email_state, synced_at = excluded.synced_at`,
    )
    .bind(mailboxId, emailState, now)
}
