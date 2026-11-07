// search_docs: what Storage search has written to Vectorize for each document. See migrations/0008_search.sql.

export type DocStatus = 'indexed' | 'skipped' | 'excluded' | 'failed'

export type DocRow = {
  doc_id: string
  file_id: string | null
  item_id: string | null
  mailbox_id: string | null
  organization_id: string
  chunks: number
  status: DocStatus
  error: string | null
  indexed_at: string
  /** Emails: the folder the message is in (a JMAP folder role), for opening a result on the Email page. */
  folder: string | null
}

/** The document id of a file (a Storage version or a mail attachment): the prefix of its vector ids. */
export const fileDoc = (fileId: string) => `file:${fileId}`
/** The document id of a message. JMAP ids are only unique within an account, hence the mailbox in front. */
export const emailDoc = (mailboxId: string, emailId: string) => `email:${mailboxId}:${emailId}`

/** The parts of a document id, or null for an id that is neither a file's nor an email's. */
export function parseDoc(docId: string): { kind: 'file'; fileId: string } | { kind: 'email'; mailboxId: string; emailId: string } | null {
  const [kind, a, b] = docId.split(':')
  if (kind === 'file' && a && !b) return { kind, fileId: a }
  if (kind === 'email' && a && b) return { kind, mailboxId: a, emailId: b }
  return null
}

export async function findMany(db: D1Database, docIds: string[]): Promise<Map<string, DocRow>> {
  if (!docIds.length) return new Map()
  const { results } = await db
    .prepare('SELECT * FROM search_docs WHERE doc_id IN (SELECT value FROM json_each(?))')
    .bind(JSON.stringify(docIds))
    .all<DocRow>()
  return new Map(results.map((r) => [r.doc_id, r]))
}

/** Writes the outcome of indexing a document, replacing any earlier outcome. */
export function upsert(db: D1Database, row: DocRow): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO search_docs (doc_id, file_id, item_id, mailbox_id, organization_id, chunks, status, error, indexed_at, folder)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (doc_id) DO UPDATE SET file_id = excluded.file_id, item_id = excluded.item_id,
         mailbox_id = excluded.mailbox_id, organization_id = excluded.organization_id, chunks = excluded.chunks,
         status = excluded.status, error = excluded.error, indexed_at = excluded.indexed_at, folder = excluded.folder`,
    )
    .bind(row.doc_id, row.file_id, row.item_id, row.mailbox_id, row.organization_id, row.chunks, row.status, row.error, row.indexed_at, row.folder)
}

/** Records where a message is now (after a move). */
export function setFolder(db: D1Database, docId: string, folder: string | null): D1PreparedStatement {
  return db.prepare('UPDATE search_docs SET folder = ? WHERE doc_id = ?').bind(folder, docId)
}

export function find(db: D1Database, docId: string): Promise<DocRow | null> {
  return db.prepare('SELECT * FROM search_docs WHERE doc_id = ?').bind(docId).first<DocRow>()
}

/** The other documents of a Storage item: earlier versions whose vectors go once a new version is indexed. */
export async function othersOfItem(db: D1Database, itemId: string, keepDocId: string): Promise<DocRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM search_docs WHERE item_id = ? AND doc_id != ?')
    .bind(itemId, keepDocId)
    .all<DocRow>()
  return results
}

export function removeMany(db: D1Database, docIds: string[]): D1PreparedStatement {
  return db.prepare('DELETE FROM search_docs WHERE doc_id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(docIds))
}

/**
 * Files that should be searchable but have no row yet: a Storage item's current version, or a ready attachment.
 * The backfill on first rollout, and the safety net for any job the queue lost.
 */
export async function unindexedFileIds(db: D1Database, limit: number): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT f.id FROM files f LEFT JOIN search_docs d ON d.file_id = f.id
       WHERE d.file_id IS NULL AND f.status = 'ready' AND (
         (f.item_id IS NOT NULL AND EXISTS (SELECT 1 FROM storage_items s WHERE s.id = f.item_id AND s.file_id = f.id))
         OR (f.mailbox_id IS NOT NULL AND f.source IN ('received', 'sent'))
       )
       ORDER BY f.created_at LIMIT ?`,
    )
    .bind(limit)
    .all<{ id: string }>()
  return results.map((r) => r.id)
}

/** Documents whose indexing failed before `before`, for one retry a day. */
export async function failedFileIds(db: D1Database, before: string, limit: number): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT file_id FROM search_docs WHERE status = 'failed' AND file_id IS NOT NULL AND indexed_at < ? ORDER BY indexed_at LIMIT ?")
    .bind(before, limit)
    .all<{ file_id: string }>()
  return results.map((r) => r.file_id)
}

/** Email documents whose indexing failed before `before`, for one retry a day. */
export async function failedEmailDocs(db: D1Database, before: string, limit: number): Promise<DocRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM search_docs WHERE status = 'failed' AND file_id IS NULL AND indexed_at < ? ORDER BY indexed_at LIMIT ?")
    .bind(before, limit)
    .all<DocRow>()
  return results
}

/**
 * Rows whose file or mailbox is gone: purged versions, deleted items, deleted mailboxes or organizations (files
 * cascade away with them). Their vectors are the only thing left to delete. Deleted messages are removed by mail
 * sync as it sees them go; this also catches any it missed because the mailbox went first.
 */
export async function orphans(db: D1Database, limit: number): Promise<DocRow[]> {
  const { results } = await db
    .prepare(
      `SELECT d.* FROM search_docs d
       LEFT JOIN files f ON f.id = d.file_id
       LEFT JOIN mailboxes m ON m.id = d.mailbox_id
       WHERE (d.file_id IS NOT NULL AND f.id IS NULL) OR (d.file_id IS NULL AND d.mailbox_id IS NOT NULL AND m.id IS NULL)
       ORDER BY d.indexed_at LIMIT ?`,
    )
    .bind(limit)
    .all<DocRow>()
  return results
}
