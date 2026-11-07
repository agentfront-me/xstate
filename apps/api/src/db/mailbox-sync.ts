// mailbox_sync table: the last JMAP Email state whose changes have been copied for each mailbox, and whether its
// existing messages have been queued for search once.

export type SyncState = { emailState: string | null; bodiesSynced: boolean }

export async function get(db: D1Database, mailboxId: string): Promise<SyncState | null> {
  const row = await db
    .prepare('SELECT email_state, bodies_synced FROM mailbox_sync WHERE mailbox_id = ?')
    .bind(mailboxId)
    .first<{ email_state: string | null; bodies_synced: number }>()
  return row ? { emailState: row.email_state, bodiesSynced: !!row.bodies_synced } : null
}

export function saveState(db: D1Database, mailboxId: string, emailState: string, now: string): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO mailbox_sync (mailbox_id, email_state, synced_at) VALUES (?, ?, ?)
       ON CONFLICT (mailbox_id) DO UPDATE SET email_state = excluded.email_state, synced_at = excluded.synced_at`,
    )
    .bind(mailboxId, emailState, now)
}

export function markBodiesSynced(db: D1Database, mailboxId: string): D1PreparedStatement {
  return db.prepare('UPDATE mailbox_sync SET bodies_synced = 1 WHERE mailbox_id = ?').bind(mailboxId)
}
