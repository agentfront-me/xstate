// The mailbox store's types and the SQL its lists run (docs/mailbox-store-plan.md, phase 1). Pure: no runtime
// imports, so `pnpm test` runs it directly under Node. The Durable Object that executes this is ./store.ts.

export type StoreFolderRole = 'inbox' | 'sent' | 'drafts' | 'archive' | 'junk' | 'trash'
export type StoreAddress = { name: string | null; email: string }

/** A folder as the mail server has it. The store keeps them so a list needs no call to the mail server. */
export type StoreFolder = { id: string; role: string | null; name: string }

/** Where a message is and how it is flagged: what changes when it is moved, read or pinned. */
export type StorePlacement = {
  id: string
  /** Every folder the message sits in (the mail server allows several). */
  folderIds: string[]
  /** The folder people think of it being in (the role of one of folderIds), or null for custom folders only. */
  folder: StoreFolderRole | null
  seen: boolean
  pinned: boolean
}

/** One message's row. `text` (the readable body) is only sent when the message is first stored. */
export type StoreMessage = StorePlacement & {
  threadId: string
  from: StoreAddress[]
  to: StoreAddress[]
  subject: string
  preview: string
  /** ISO time. */
  receivedAt: string
  size: number
  hasAttachment: boolean
  text?: string
}

export type StoreListQuery = {
  /** A folder role, 'pinned' (flagged, not in junk or trash) or 'all' (every folder but junk and trash). */
  folder: StoreFolderRole | 'pinned' | 'all'
  unreadOnly?: boolean
  /** Words to find anywhere: all of them in the subject or body, or the whole text as part of a header. */
  text?: string
  /** Part of the sender, a recipient or the subject (an address, a domain, a name). */
  from?: string
  to?: string
  subject?: string
  /** ISO times: received at or after `after`, strictly before `before`. */
  after?: string
  before?: string
  hasAttachment?: boolean
  limit: number
}

/** A row of `messages` as SQLite returns it. */
export type StoreRow = {
  n: number
  id: string
  thread_id: string
  folder: StoreFolderRole | null
  seen: number
  pinned: number
  from_json: string
  to_json: string
  subject: string
  preview: string
  received_s: number
  size: number
  has_attachment: number
}

/** A list row: the message, and how many messages its conversation has in any folder. */
export type StoreListRow = Omit<StoreMessage, 'folderIds' | 'text'> & { threadSize: number }

/** Body text kept per message for the word index. Longer text is cut (attachments are indexed by Vectorize). */
export const MAX_INDEXED_CHARS = 250_000

export const toSeconds = (iso: string): number => Math.floor(Date.parse(iso) / 1000)
/** The mail server's own form: seconds, no milliseconds. */
export const fromSeconds = (s: number): string => new Date(s * 1000).toISOString().replace('.000Z', 'Z')

/** The sender's address, its domain and name, for the columns lists filter on. */
export function senderParts(from: StoreAddress[]): { addr: string; domain: string; name: string } {
  const first = from[0]
  const addr = (first?.email ?? '').trim().toLowerCase()
  const at = addr.lastIndexOf('@')
  return { addr, domain: at >= 0 ? addr.slice(at + 1) : '', name: first?.name ?? '' }
}

/** What the header index stores for a list of addresses: names and addresses, one after the other. */
export const addressText = (list: StoreAddress[]): string => list.map((a) => (a.name ? `${a.name} ${a.email}` : a.email)).join(' ')

/** A string as an FTS5 phrase: quoted, with quotes inside doubled. */
const phrase = (s: string) => `"${s.replace(/"/g, '""')}"`

/**
 * The words of a query for the body index, as an FTS5 expression that needs all of them. The index keeps no word
 * positions, so a phrase of several words can't be asked for: each word is its own term. Null when there are none.
 */
export function wordMatch(text: string): string | null {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  const unique = [...new Set(words)].slice(0, 20)
  return unique.length ? unique.map(phrase).join(' ') : null
}

/** The trigram index needs three characters to match on. */
const TRIGRAM_MIN = 3

/** `value` as part of one header column of the trigram index. Null when it is too short for trigrams. */
export function headerMatch(column: 'sender' | 'recipients' | 'subject' | null, value: string): string | null {
  const v = value.trim()
  if ([...v].length < TRIGRAM_MIN) return null
  return column ? `${column} : ${phrase(v)}` : phrase(v)
}

const like = (v: string) => `%${v.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`

type Sql = { sql: string; params: (string | number)[] }

/** A header filter: through the trigram index, or a plain LIKE for values too short for it. */
function headerFilter(column: 'sender' | 'recipients' | 'subject', value: string): Sql {
  const match = headerMatch(column, value)
  if (match) return { sql: 'm.n IN (SELECT rowid FROM headers_fts WHERE headers_fts MATCH ?)', params: [match] }
  const field = column === 'sender' ? 'm.from_json' : column === 'recipients' ? 'm.to_json' : 'm.subject'
  return { sql: `${field} LIKE ? ESCAPE '\\'`, params: [like(value)] }
}

/** Where a page starts: strictly after this row in newest-first order. */
export type PageStart = { receivedS: number; n: number }

/**
 * One page of matching messages, newest first (not yet one per conversation: the store collapses them). Null when
 * the mailbox has no folder with the role asked for, so there is nothing to list.
 */
export function listSql(q: StoreListQuery, folders: StoreFolder[], fetch: number, start?: PageStart): Sql | null {
  const where: string[] = []
  const params: (string | number)[] = []
  const add = (part: Sql) => {
    where.push(part.sql)
    params.push(...part.params)
  }
  const marks = (ids: string[]) => ids.map(() => '?').join(', ')
  const byRole = (role: string) => folders.filter((f) => f.role === role).map((f) => f.id)

  let from = 'messages m'
  // In one folder, the placements index gives the order; otherwise the messages' own received_s index does.
  let order = 'm.received_s DESC, m.n DESC'
  if (q.folder === 'pinned' || q.folder === 'all') {
    const hidden = [...byRole('junk'), ...byRole('trash')]
    if (hidden.length) add({ sql: `EXISTS (SELECT 1 FROM placements p WHERE p.n = m.n AND p.folder_id NOT IN (${marks(hidden)}))`, params: hidden })
    if (q.folder === 'pinned') where.push('m.pinned = 1')
  } else {
    const ids = byRole(q.folder)
    if (!ids.length) return null
    from = 'placements p JOIN messages m ON m.n = p.n'
    add({ sql: ids.length === 1 ? 'p.folder_id = ?' : `p.folder_id IN (${marks(ids)})`, params: ids })
    order = 'p.received_s DESC, p.n DESC'
  }

  if (q.unreadOnly) where.push('m.seen = 0')
  if (q.hasAttachment !== undefined) where.push(`m.has_attachment = ${q.hasAttachment ? 1 : 0}`)
  if (q.after) add({ sql: 'm.received_s >= ?', params: [Date.parse(q.after) / 1000] })
  if (q.before) add({ sql: 'm.received_s < ?', params: [Date.parse(q.before) / 1000] })
  if (q.from?.trim()) add(headerFilter('sender', q.from))
  if (q.to?.trim()) add(headerFilter('recipients', q.to))
  if (q.subject?.trim()) add(headerFilter('subject', q.subject))
  if (q.text?.trim()) {
    const any: Sql[] = []
    const words = wordMatch(q.text)
    if (words) any.push({ sql: 'm.n IN (SELECT rowid FROM text_fts WHERE text_fts MATCH ?)', params: [words] })
    const header = headerMatch(null, q.text)
    if (header) any.push({ sql: 'm.n IN (SELECT rowid FROM headers_fts WHERE headers_fts MATCH ?)', params: [header] })
    // Nothing searchable in the text (punctuation only): match nothing rather than everything.
    if (!any.length) where.push('0')
    else add({ sql: `(${any.map((a) => a.sql).join(' OR ')})`, params: any.flatMap((a) => a.params) })
  }
  if (start) add({ sql: '(m.received_s < ? OR (m.received_s = ? AND m.n < ?))', params: [start.receivedS, start.receivedS, start.n] })

  const sql = `SELECT m.n, m.id, m.thread_id, m.folder, m.seen, m.pinned, m.from_json, m.to_json, m.subject, m.preview,
    m.received_s, m.size, m.has_attachment FROM ${from}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY ${order} LIMIT ?`
  return { sql, params: [...params, fetch] }
}

export function rowToList(row: StoreRow, threadSize: number): StoreListRow {
  return {
    id: row.id,
    threadId: row.thread_id,
    folder: row.folder,
    seen: !!row.seen,
    pinned: !!row.pinned,
    from: JSON.parse(row.from_json) as StoreAddress[],
    to: JSON.parse(row.to_json) as StoreAddress[],
    subject: row.subject,
    preview: row.preview,
    receivedAt: fromSeconds(row.received_s),
    size: row.size,
    hasAttachment: !!row.has_attachment,
    threadSize,
  }
}
