// files table: what is stored in each organization's R2 bucket. See migrations/0002_files.sql.

export type FileSource = 'received' | 'sent' | 'upload'
export type FileStatus = 'pending' | 'ready' | 'deleted'

export type FileRow = {
  id: string
  organization_id: string
  mailbox_id: string | null
  r2_key: string
  name: string
  content_type: string
  size_bytes: number
  sha256: string | null
  source: FileSource
  status: FileStatus
  email_id: string | null
  thread_id: string | null
  part_id: string | null
  stalwart_blob_id: string | null
  disposition: 'attachment' | 'inline' | null
  content_id: string | null
  created_by: string | null
  created_at: string
  deleted_at: string | null
}

export type NewFile = Omit<FileRow, 'status' | 'deleted_at' | 'sha256'> & { status?: FileStatus; sha256?: string | null }

/** Adds a file. An attachment part that is already recorded is left alone (check `meta.changes`). */
export function insert(db: D1Database, f: NewFile): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO files (id, organization_id, mailbox_id, r2_key, name, content_type, size_bytes, sha256, source, status,
         email_id, thread_id, part_id, stalwart_blob_id, disposition, content_id, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
    )
    .bind(
      f.id,
      f.organization_id,
      f.mailbox_id,
      f.r2_key,
      f.name,
      f.content_type,
      f.size_bytes,
      f.sha256 ?? null,
      f.source,
      f.status ?? 'ready',
      f.email_id,
      f.thread_id,
      f.part_id,
      f.stalwart_blob_id,
      f.disposition,
      f.content_id,
      f.created_by,
      f.created_at,
    )
}

/** The row for one attachment part of a message, if it was recorded before. */
export function findPart(db: D1Database, mailboxId: string, emailId: string, partId: string): Promise<FileRow | null> {
  return db
    .prepare('SELECT * FROM files WHERE mailbox_id = ? AND email_id = ? AND part_id = ?')
    .bind(mailboxId, emailId, partId)
    .first<FileRow>()
}

export function find(db: D1Database, id: string): Promise<FileRow | null> {
  return db.prepare('SELECT * FROM files WHERE id = ?').bind(id).first<FileRow>()
}

/** A mailbox's files that aren't deleted, newest first. */
export async function listForMailbox(
  db: D1Database,
  mailboxId: string,
  options: { emailId?: string; before?: string; limit: number },
): Promise<FileRow[]> {
  const where = ["mailbox_id = ?", "status != 'deleted'"]
  const params: unknown[] = [mailboxId]
  if (options.emailId) {
    where.push('email_id = ?')
    params.push(options.emailId)
  }
  if (options.before) {
    where.push('created_at < ?')
    params.push(options.before)
  }
  const { results } = await db
    .prepare(`SELECT * FROM files WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ?`)
    .bind(...params, options.limit)
    .all<FileRow>()
  return results
}

export function remove(db: D1Database, id: string): D1PreparedStatement {
  return db.prepare('DELETE FROM files WHERE id = ?').bind(id)
}

export function markReady(db: D1Database, id: string, sizeBytes: number, sha256: string | null): D1PreparedStatement {
  return db.prepare("UPDATE files SET status = 'ready', size_bytes = ?, sha256 = ? WHERE id = ?").bind(sizeBytes, sha256, id)
}

/** Marks the files of deleted messages as deleted; their R2 objects are removed later, after a grace period. */
export function markDeletedForEmails(db: D1Database, mailboxId: string, emailIds: string[], now: string): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE files SET status = 'deleted', deleted_at = ?
       WHERE mailbox_id = ? AND email_id IN (SELECT value FROM json_each(?)) AND status != 'deleted'`,
    )
    .bind(now, mailboxId, JSON.stringify(emailIds))
}
