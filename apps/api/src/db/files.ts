// files table: what is stored in each organization's R2 bucket. See migrations/0002_files.sql.

export type FileSource = 'received' | 'sent' | 'upload' | 'drive'
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
  item_id: string | null
  version: number | null
  created_by: string | null
  created_at: string
  deleted_at: string | null
  /** 1 once an admin has kept the file out of search (search/). */
  search_excluded: number
}

export type NewFile = Omit<FileRow, 'status' | 'deleted_at' | 'sha256' | 'item_id' | 'version' | 'search_excluded'> & {
  status?: FileStatus
  sha256?: string | null
  item_id?: string | null
  version?: number | null
}

/** Adds a file. An attachment part that is already recorded is left alone (check `meta.changes`). */
export function insert(db: D1Database, f: NewFile): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO files (id, organization_id, mailbox_id, r2_key, name, content_type, size_bytes, sha256, source, status,
         email_id, thread_id, part_id, stalwart_blob_id, disposition, content_id, item_id, version, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      f.item_id ?? null,
      f.version ?? null,
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

/** Many files by id, whatever their status. */
export async function findMany(db: D1Database, ids: string[]): Promise<Map<string, FileRow>> {
  if (!ids.length) return new Map()
  const { results } = await db
    .prepare('SELECT * FROM files WHERE id IN (SELECT value FROM json_each(?))')
    .bind(JSON.stringify(ids))
    .all<FileRow>()
  return new Map(results.map((r) => [r.id, r]))
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

export function setSearchExcluded(db: D1Database, id: string, excluded: boolean): D1PreparedStatement {
  return db.prepare('UPDATE files SET search_excluded = ? WHERE id = ?').bind(excluded ? 1 : 0, id)
}

/** A new version keeps the replaced version's search exclusion, so an admin's choice sticks across edits. */
export function copySearchExcluded(db: D1Database, fromId: string, toId: string): D1PreparedStatement {
  return db.prepare('UPDATE files SET search_excluded = (SELECT search_excluded FROM files WHERE id = ?) WHERE id = ?').bind(fromId, toId)
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

/** Files deleted before `before`, oldest first, with their organization's bucket (null if it was never created). */
export async function listPurgeable(db: D1Database, before: string, limit: number) {
  const { results } = await db
    .prepare(
      `SELECT f.id, f.r2_key, o.r2_bucket AS bucket FROM files f JOIN organizations o ON o.id = f.organization_id
       WHERE f.status = 'deleted' AND f.deleted_at < ? ORDER BY f.deleted_at LIMIT ?`,
    )
    .bind(before, limit)
    .all<{ id: string; r2_key: string; bucket: string | null }>()
  return results
}

/** Removes rows for good, once their R2 objects are gone. */
export function removeMany(db: D1Database, ids: string[]): D1PreparedStatement {
  return db.prepare('DELETE FROM files WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(ids))
}

// Mail attachments, as Storage's "Mail Attachments" folder

/**
 * Attachments of the given mailboxes, newest first. Inline images are left out; they're part of the message, not
 * files anyone sent on purpose. `before` is a `created_at|id` cursor from the previous page.
 */
export async function listAttachments(
  db: D1Database,
  mailboxIds: string[],
  options: { source?: 'received' | 'sent'; query?: string; before?: { createdAt: string; id: string }; limit: number },
): Promise<FileRow[]> {
  if (!mailboxIds.length) return []
  const where = [
    'mailbox_id IN (SELECT value FROM json_each(?))',
    "status = 'ready'",
    "IFNULL(disposition, 'attachment') = 'attachment'",
  ]
  const params: unknown[] = [JSON.stringify(mailboxIds)]
  if (options.source) {
    where.push('source = ?')
    params.push(options.source)
  }
  if (options.query) {
    where.push("name LIKE ? ESCAPE '\\'")
    params.push(`%${options.query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`)
  }
  if (options.before) {
    where.push('(created_at < ? OR (created_at = ? AND id < ?))')
    params.push(options.before.createdAt, options.before.createdAt, options.before.id)
  }
  const { results } = await db
    .prepare(`SELECT * FROM files WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`)
    .bind(...params, options.limit)
    .all<FileRow>()
  return results
}

/** Ready attachments per mailbox, with their total size, for the folder counts. */
export async function countAttachments(db: D1Database, mailboxIds: string[]): Promise<Map<string, { n: number; bytes: number }>> {
  if (!mailboxIds.length) return new Map()
  const { results } = await db
    .prepare(
      `SELECT mailbox_id, COUNT(*) AS n, COALESCE(SUM(size_bytes), 0) AS bytes FROM files
       WHERE mailbox_id IN (SELECT value FROM json_each(?))
       AND status = 'ready' AND IFNULL(disposition, 'attachment') = 'attachment' GROUP BY mailbox_id`,
    )
    .bind(JSON.stringify(mailboxIds))
    .all<{ mailbox_id: string; n: number; bytes: number }>()
  return new Map(results.map((r) => [r.mailbox_id, { n: r.n, bytes: r.bytes }]))
}

// Storage file versions

/** Versions kept besides the current one, and for how long after they were replaced. */
export const KEPT_VERSIONS = 5
export const VERSION_DAYS = 30

/**
 * The item's earlier versions still kept: the newest KEPT_VERSIONS replaced less than VERSION_DAYS ago. Replaced
 * versions are 'deleted' with deleted_at set to when they were replaced, so the purge removes them on time.
 */
export async function previousVersions(db: D1Database, itemId: string, currentFileId: string, now = new Date()) {
  const since = new Date(now.getTime() - VERSION_DAYS * 86_400_000).toISOString()
  const { results } = await db
    .prepare(
      `SELECT f.*, u.name AS created_by_name FROM files f LEFT JOIN users u ON u.id = f.created_by
       WHERE f.item_id = ? AND f.id != ? AND f.deleted_at > ? ORDER BY f.version DESC LIMIT ?`,
    )
    .bind(itemId, currentFileId, since, KEPT_VERSIONS)
    .all<FileRow & { created_by_name: string | null }>()
  return results
}

/**
 * After a new version: the one it replaced starts its VERSION_DAYS countdown, and anything older than the newest
 * KEPT_VERSIONS earlier versions is due for the purge straight away.
 */
export function retireVersions(db: D1Database, itemId: string, replacedFileId: string, now: string): D1PreparedStatement[] {
  return [
    db.prepare("UPDATE files SET status = 'deleted', deleted_at = ? WHERE id = ? AND status != 'deleted'").bind(now, replacedFileId),
    db
      .prepare(
        `UPDATE files SET deleted_at = '1970-01-01T00:00:00.000Z' WHERE id IN (
           SELECT id FROM files WHERE item_id = ? AND status = 'deleted' ORDER BY version DESC LIMIT -1 OFFSET ?
         )`,
      )
      .bind(itemId, KEPT_VERSIONS),
  ]
}
