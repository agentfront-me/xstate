// MailboxStore: one Durable Object per mailbox holding its message index (docs/mailbox-store-plan.md, phase 1).
// For now it is a shadow copy fed from Stalwart by ./shadow.ts: headers, folders, flags and the body text of every
// message, so lists, filters and search can be answered without the mail server. Message contents stay where they
// are. It does small, fast work only: fetching and parsing happen in the Workers and queues that call it.

import { Agent } from 'agents'
import {
  MAX_INDEXED_CHARS,
  addressText,
  fromSeconds,
  listSql,
  rowToList,
  senderParts,
  toSeconds,
  type PageStart,
  type StoreAddress,
  type StoreFolder,
  type StoreListQuery,
  type StoreListRow,
  type StoreMessage,
  type StorePlacement,
  type StoreRow,
} from './query'

/** Where the copy from the mail server stands. */
export type StoreSync = {
  /** The mail server's change state the store has caught up to, or null before the first copy. */
  state: string | null
  /** When the first copy was queued. */
  startedAt: string | null
  /** The COPY_VERSION (./shadow.ts) the copy was made with: a newer one means copy again. */
  version: number | null
}

export type FolderCount = { folderId: string; total: number; unread: number }

/** Where one attachment sits inside its raw message. */
export type StoreAttachment = {
  /** The attachment's `files` row in D1, when one with the same content was found. */
  fileId: string | null
  name: string | null
  type: string
  /** Decoded size in bytes. */
  size: number
  /** Where the encoded body is in the raw message. */
  start: number
  length: number
  encoding: string
  /** Read back from the bucket by position and found identical; null when it wasn't tried. */
  verified: boolean | null
}

/** A message's raw copy. `key` is '' for a message that was skipped (too large). */
export type StoreRaw = {
  id: string
  key: string
  size: number
  /** Fields our own reading of the message differs in from the mail server's, comma-separated; '' when none. */
  diff: string
  attachments: StoreAttachment[]
}

/** A message of a conversation, as `thread` gives it. */
export type StoreThreadMessage = StoreListRow & {
  rawKey: string | null
  rawSize: number | null
  attachments: { start: number; size: number }[]
}

/** Where to read an attachment. `length` is -1 when the store has no record of it: look in the raw copy. */
export type StoreAttachmentPlace = { rawKey: string; start: number; length: number; encoding: string; type: string }

export type RawStats = {
  messages: number
  /** Raw messages copied to the bucket, skipped (too large) and still to copy. */
  copied: number
  skipped: number
  missing: number
  bytes: number
  attachments: number
  /** Attachments matched to a `files` row by content. */
  matched: number
  /** Attachments read back by position: identical, and not. */
  verified: number
  unverified: number
  /** Messages by which fields differ between our parsing and the mail server's ('' is none). */
  diffs: Record<string, number>
  /** A few message ids that differ, to look at. */
  diffSample: string[]
}

/** How long a message handed out for copying is left alone before it is handed out again. */
const RAW_RETRY_SECONDS = 6 * 3600

/** Rows fetched per round while collapsing a list to one row per conversation, as a multiple of the page size. */
const FETCH_FACTOR = 2
/** Rounds before a list gives up filling its page (a mailbox of very long conversations). */
const MAX_ROUNDS = 8
/** Bound parameters per statement: Durable Objects allow 100. */
const IN_CHUNK = 90

export class MailboxStore extends Agent<Env> {
  async onStart() {
    const sql = this.ctx.storage.sql
    sql.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`)
    sql.exec(`CREATE TABLE IF NOT EXISTS folders (id TEXT PRIMARY KEY, role TEXT, name TEXT NOT NULL)`)
    sql.exec(`CREATE TABLE IF NOT EXISTS messages (
      n INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, thread_id TEXT NOT NULL, folder TEXT,
      seen INTEGER NOT NULL, pinned INTEGER NOT NULL, from_addr TEXT NOT NULL, from_domain TEXT NOT NULL,
      from_json TEXT NOT NULL, to_json TEXT NOT NULL, subject TEXT NOT NULL, preview TEXT NOT NULL,
      received_s INTEGER NOT NULL, size INTEGER NOT NULL, has_attachment INTEGER NOT NULL)`)
    sql.exec(`CREATE INDEX IF NOT EXISTS messages_received ON messages (received_s DESC, n DESC)`)
    sql.exec(`CREATE INDEX IF NOT EXISTS messages_domain ON messages (from_domain, received_s DESC)`)
    sql.exec(`CREATE INDEX IF NOT EXISTS messages_addr ON messages (from_addr, received_s DESC)`)
    sql.exec(`CREATE INDEX IF NOT EXISTS messages_thread ON messages (thread_id)`)
    // One row per folder a message sits in, in list order, so a folder's newest page reads only its own rows.
    sql.exec(`CREATE TABLE IF NOT EXISTS placements (
      folder_id TEXT NOT NULL, received_s INTEGER NOT NULL, n INTEGER NOT NULL, seen INTEGER NOT NULL,
      PRIMARY KEY (folder_id, received_s, n)) WITHOUT ROWID`)
    sql.exec(`CREATE INDEX IF NOT EXISTS placements_n ON placements (n)`)
    // The raw copy: added after the first version, so by ALTER, which fails harmlessly when the column is there.
    for (const column of ['raw_key TEXT', 'raw_size INTEGER', 'raw_queued_s INTEGER', 'parse_diff TEXT']) {
      try {
        sql.exec(`ALTER TABLE messages ADD COLUMN ${column}`)
      } catch {
        // already added
      }
    }
    sql.exec(`CREATE INDEX IF NOT EXISTS messages_no_raw ON messages (n) WHERE raw_key IS NULL`)
    sql.exec(`CREATE TABLE IF NOT EXISTS attachments (
      n INTEGER NOT NULL, seq INTEGER NOT NULL, file_id TEXT, name TEXT, type TEXT NOT NULL, size INTEGER NOT NULL,
      start INTEGER NOT NULL, length INTEGER NOT NULL, encoding TEXT NOT NULL, verified INTEGER,
      PRIMARY KEY (n, seq)) WITHOUT ROWID`)
    // Headers by trigram, so part of an address, a domain or a subject matches. Bodies by word, without positions:
    // a tenth of the size, at the cost of exact phrases (spike findings in the plan).
    sql.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS headers_fts USING fts5(sender, recipients, subject, tokenize='trigram', content='', contentless_delete=1)`)
    // Words are reduced to their English stem (porter), as Stalwart's search does, so "workspace" also finds
    // "workspaces". A store made before stemming has its word index rebuilt: dropped here, refilled by the recopy
    // that the COPY_VERSION change in ./shadow.ts starts.
    const textIndex = [...sql.exec(`SELECT sql FROM sqlite_master WHERE name = 'text_fts'`)][0]?.sql as string | undefined
    if (textIndex && !textIndex.includes('porter')) sql.exec(`DROP TABLE text_fts`)
    sql.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS text_fts USING fts5(subject, body, tokenize='porter unicode61 remove_diacritics 2', detail='none', content='', contentless_delete=1)`)
  }

  private get db() {
    return this.ctx.storage.sql
  }

  private meta(key: string): string | null {
    return ([...this.db.exec(`SELECT value FROM meta WHERE key = ?`, key)][0]?.value as string | undefined) ?? null
  }

  private setMeta(key: string, value: string | null) {
    if (value === null) this.db.exec(`DELETE FROM meta WHERE key = ?`, key)
    else this.db.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`, key, value)
  }

  // -------------------------------------------------------------------------------------------------------------
  // Copy state

  getSync(): StoreSync {
    const version = this.meta('version')
    return { state: this.meta('state'), startedAt: this.meta('started_at'), version: version === null ? null : Number(version) }
  }

  setSync(state: string, version: number) {
    this.setMeta('state', state)
    this.setMeta('version', String(version))
    if (!this.meta('started_at')) this.setMeta('started_at', new Date().toISOString())
  }

  /** Empties the store, to copy the mailbox again from the start (the mail server's change state expired). */
  reset() {
    this.ctx.storage.transactionSync(() => {
      for (const table of ['messages', 'placements', 'attachments', 'headers_fts', 'text_fts', 'folders', 'meta']) this.db.exec(`DELETE FROM ${table}`)
    })
  }

  setFolders(folders: StoreFolder[]) {
    this.ctx.storage.transactionSync(() => {
      this.db.exec(`DELETE FROM folders`)
      for (const f of folders) this.db.exec(`INSERT INTO folders (id, role, name) VALUES (?, ?, ?)`, f.id, f.role, f.name)
    })
  }

  private folders(): StoreFolder[] {
    return [...this.db.exec(`SELECT id, role, name FROM folders`)] as unknown as StoreFolder[]
  }

  // -------------------------------------------------------------------------------------------------------------
  // Writes

  /** Adds messages, or replaces the ones already there. Safe to repeat. */
  upsert(messages: StoreMessage[]): { stored: number } {
    this.ctx.storage.transactionSync(() => {
      for (const m of messages) this.upsertOne(m)
    })
    return { stored: messages.length }
  }

  private upsertOne(m: StoreMessage) {
    const sender = senderParts(m.from)
    const receivedS = toSeconds(m.receivedAt)
    const values = [
      m.threadId, m.folder, m.seen ? 1 : 0, m.pinned ? 1 : 0, sender.addr, sender.domain, JSON.stringify(m.from),
      JSON.stringify(m.to), m.subject, m.preview, receivedS, m.size, m.hasAttachment ? 1 : 0,
    ]
    const existing = [...this.db.exec(`SELECT n FROM messages WHERE id = ?`, m.id)][0]?.n as number | undefined
    let n: number
    if (existing === undefined) {
      this.db.exec(
        `INSERT INTO messages (thread_id, folder, seen, pinned, from_addr, from_domain, from_json, to_json, subject, preview,
          received_s, size, has_attachment, id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ...values, m.id,
      )
      n = [...this.db.exec(`SELECT n FROM messages WHERE id = ?`, m.id)][0]!.n as number
    } else {
      n = existing
      this.db.exec(
        `UPDATE messages SET thread_id = ?, folder = ?, seen = ?, pinned = ?, from_addr = ?, from_domain = ?, from_json = ?,
          to_json = ?, subject = ?, preview = ?, received_s = ?, size = ?, has_attachment = ? WHERE n = ?`,
        ...values, n,
      )
      this.db.exec(`DELETE FROM headers_fts WHERE rowid = ?`, n)
    }
    this.place(n, receivedS, m.folderIds, m.seen)
    this.db.exec(`INSERT INTO headers_fts (rowid, sender, recipients, subject) VALUES (?, ?, ?, ?)`, n, addressText(m.from), addressText(m.to), m.subject)
    if (m.text !== undefined) {
      if (existing !== undefined) this.db.exec(`DELETE FROM text_fts WHERE rowid = ?`, n)
      this.db.exec(`INSERT INTO text_fts (rowid, subject, body) VALUES (?, ?, ?)`, n, m.subject, m.text.slice(0, MAX_INDEXED_CHARS))
    }
  }

  private place(n: number, receivedS: number, folderIds: string[], seen: boolean) {
    this.db.exec(`DELETE FROM placements WHERE n = ?`, n)
    for (const folderId of new Set(folderIds)) {
      this.db.exec(`INSERT INTO placements (folder_id, received_s, n, seen) VALUES (?, ?, ?, ?)`, folderId, receivedS, n, seen ? 1 : 0)
    }
  }

  /** Records moves and flag changes. Messages the store doesn't have yet are left for the copy to bring. */
  setPlacements(placements: StorePlacement[]): { changed: number } {
    let changed = 0
    this.ctx.storage.transactionSync(() => {
      for (const p of placements) {
        const row = [...this.db.exec(`SELECT n, received_s FROM messages WHERE id = ?`, p.id)][0] as { n: number; received_s: number } | undefined
        if (!row) continue
        this.db.exec(`UPDATE messages SET folder = ?, seen = ?, pinned = ? WHERE n = ?`, p.folder, p.seen ? 1 : 0, p.pinned ? 1 : 0, row.n)
        this.place(row.n, row.received_s, p.folderIds, p.seen)
        changed++
      }
    })
    return { changed }
  }

  /** Removes messages. Returns the keys of their raw copies, for the caller to delete from the bucket. */
  remove(ids: string[]): { removed: number; rawKeys: string[] } {
    let removed = 0
    const rawKeys: string[] = []
    this.ctx.storage.transactionSync(() => {
      for (const id of ids) {
        const row = [...this.db.exec(`SELECT n, raw_key FROM messages WHERE id = ?`, id)][0] as { n: number; raw_key: string | null } | undefined
        if (!row) continue
        const n = row.n
        if (row.raw_key) rawKeys.push(row.raw_key)
        this.db.exec(`DELETE FROM attachments WHERE n = ?`, n)
        this.db.exec(`DELETE FROM placements WHERE n = ?`, n)
        this.db.exec(`DELETE FROM headers_fts WHERE rowid = ?`, n)
        this.db.exec(`DELETE FROM text_fts WHERE rowid = ?`, n)
        this.db.exec(`DELETE FROM messages WHERE n = ?`, n)
        removed++
      }
    })
    return { removed, rawKeys }
  }

  // -------------------------------------------------------------------------------------------------------------
  // Raw copies

  /**
   * Ids of messages whose raw copy hasn't been made, newest first, marking them as handed out so the next call
   * gives different ones. A message handed out and not finished comes back after RAW_RETRY_SECONDS. Hands out only
   * as many as keep `maxInFlight` or fewer handed out and unfinished, so syncs that come often (every new email)
   * don't pile batches up behind each other.
   *
   * One statement each for counting and for marking: this object answers one request at a time, and marking
   * thousands of rows one by one kept the copy jobs waiting until they were refused ("Durable Object is overloaded").
   */
  missingRaw(limit: number, maxInFlight: number): string[] {
    const now = Math.floor(Date.now() / 1000)
    const since = now - RAW_RETRY_SECONDS
    const inFlight = [...this.db.exec(`SELECT COUNT(*) AS c FROM messages WHERE raw_key IS NULL AND raw_queued_s >= ?`, since)][0]!.c as number
    const take = Math.min(limit, maxInFlight - inFlight)
    if (take <= 0) return []
    const rows = [...this.db.exec(
      `UPDATE messages SET raw_queued_s = ? WHERE n IN (
        SELECT n FROM messages WHERE raw_key IS NULL AND (raw_queued_s IS NULL OR raw_queued_s < ?) ORDER BY n DESC LIMIT ?
      ) RETURNING id`,
      now, since, take,
    )] as { id: string }[]
    return rows.map((r) => r.id)
  }

  /** Records raw copies and where their attachments sit. Messages that have gone meanwhile are left out. */
  setRaw(items: StoreRaw[]): { recorded: number; gone: string[] } {
    let recorded = 0
    const gone: string[] = []
    this.ctx.storage.transactionSync(() => {
      for (const item of items) {
        const n = [...this.db.exec(`SELECT n FROM messages WHERE id = ?`, item.id)][0]?.n as number | undefined
        if (n === undefined) {
          gone.push(item.id)
          continue
        }
        this.db.exec(`UPDATE messages SET raw_key = ?, raw_size = ?, parse_diff = ? WHERE n = ?`, item.key, item.size, item.diff, n)
        this.db.exec(`DELETE FROM attachments WHERE n = ?`, n)
        item.attachments.forEach((a, seq) => {
          this.db.exec(
            `INSERT INTO attachments (n, seq, file_id, name, type, size, start, length, encoding, verified) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            n, seq, a.fileId, a.name, a.type, a.size, a.start, a.length, a.encoding, a.verified === null ? null : a.verified ? 1 : 0,
          )
        })
        recorded++
      }
    })
    return { recorded, gone }
  }

  rawStats(): RawStats {
    const one = (q: string) => [...this.db.exec(q)][0] as Record<string, number>
    const m = one(`SELECT COUNT(*) AS messages, COALESCE(SUM(raw_key IS NOT NULL AND raw_key != ''), 0) AS copied,
      COALESCE(SUM(raw_key = ''), 0) AS skipped, COALESCE(SUM(raw_key IS NULL), 0) AS missing, COALESCE(SUM(raw_size), 0) AS bytes FROM messages`)
    const a = one(`SELECT COUNT(*) AS attachments, COALESCE(SUM(file_id IS NOT NULL), 0) AS matched,
      COALESCE(SUM(verified = 1), 0) AS verified, COALESCE(SUM(verified = 0), 0) AS unverified FROM attachments`)
    const diffs: Record<string, number> = {}
    for (const row of this.db.exec(`SELECT parse_diff AS d, COUNT(*) AS c FROM messages WHERE parse_diff IS NOT NULL GROUP BY parse_diff`)) diffs[row.d as string] = row.c as number
    const diffSample = [...this.db.exec(`SELECT id FROM messages WHERE parse_diff IS NOT NULL AND parse_diff != '' ORDER BY n DESC LIMIT 5`)].map((r) => r.id as string)
    return { messages: m.messages!, copied: m.copied!, skipped: m.skipped!, missing: m.missing!, bytes: m.bytes!, ...(a as { attachments: number; matched: number; verified: number; unverified: number }), diffs, diffSample }
  }

  // -------------------------------------------------------------------------------------------------------------
  // Reads

  /**
   * The newest conversations that match, one row per conversation (its newest matching message), newest first.
   * `more` says another page may exist: ask again with `before` set to the last row's receivedAt.
   */
  list(q: StoreListQuery): { messages: StoreListRow[]; more: boolean } {
    const folders = this.folders()
    const picked: StoreRow[] = []
    const threads = new Set<string>()
    const seenRows = new Set<number>()
    const fetch = Math.max(q.limit * FETCH_FACTOR, 20)
    let start: PageStart | undefined
    let more = false
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const page = listSql(q, folders, fetch, start)
      if (!page) break
      const rows = [...this.db.exec(page.sql, ...page.params)] as unknown as StoreRow[]
      for (const row of rows) {
        // A message in two folders of the same role comes back twice.
        if (seenRows.has(row.n)) continue
        seenRows.add(row.n)
        if (threads.has(row.thread_id)) continue
        if (picked.length === q.limit) {
          more = true
          break
        }
        threads.add(row.thread_id)
        picked.push(row)
      }
      if (more || rows.length < fetch) break
      const last = rows[rows.length - 1]!
      start = { receivedS: last.received_s, n: last.n }
      // The page is full and rows remain: there may be more conversations.
      if (picked.length === q.limit) {
        more = true
        break
      }
    }
    const sizes = this.threadSizes(picked.map((r) => r.thread_id))
    return { messages: picked.map((r) => rowToList(r, sizes.get(r.thread_id) ?? 1)), more }
  }

  private threadSizes(threadIds: string[]): Map<string, number> {
    const sizes = new Map<string, number>()
    for (let i = 0; i < threadIds.length; i += IN_CHUNK) {
      const chunk = threadIds.slice(i, i + IN_CHUNK)
      const rows = this.db.exec(`SELECT thread_id, COUNT(*) AS c FROM messages WHERE thread_id IN (${chunk.map(() => '?').join(', ')}) GROUP BY thread_id`, ...chunk)
      for (const row of rows) sizes.set(row.thread_id as string, row.c as number)
    }
    return sizes
  }

  /**
   * Every message of a conversation, oldest first, with where its raw copy is (`rawKey` null before it is copied,
   * '' when it was too large) and the decoded size of each attachment, by its position in the raw message.
   */
  thread(threadId: string): StoreThreadMessage[] {
    const rows = [...this.db.exec(
      `SELECT n, id, thread_id, folder, seen, pinned, from_json, to_json, subject, preview, received_s, size, has_attachment,
        raw_key, raw_size FROM messages WHERE thread_id = ? ORDER BY received_s, n`,
      threadId,
    )] as unknown as (StoreRow & { raw_key: string | null; raw_size: number | null })[]
    return rows.map((row) => ({
      ...rowToList(row, rows.length),
      rawKey: row.raw_key,
      rawSize: row.raw_size,
      attachments: [...this.db.exec(`SELECT start, size FROM attachments WHERE n = ? ORDER BY seq`, row.n)] as unknown as { start: number; size: number }[],
    }))
  }

  /** Where an attachment sits: its message's raw copy and the encoded range, found by the range's start. */
  attachmentAt(emailId: string, start: number): StoreAttachmentPlace | null {
    const row = [...this.db.exec(
      `SELECT m.raw_key AS rawKey, a.start, a.length, a.encoding, a.type FROM messages m JOIN attachments a ON a.n = m.n
        WHERE m.id = ? AND a.start = ?`,
      emailId, start,
    )][0] as StoreAttachmentPlace | undefined
    if (row) return row
    // Not recorded (or recorded under another part): the caller can still find it in the raw copy.
    const msg = [...this.db.exec(`SELECT raw_key AS rawKey FROM messages WHERE id = ?`, emailId)][0] as { rawKey: string | null } | undefined
    return msg?.rawKey ? { rawKey: msg.rawKey, start, length: -1, encoding: '', type: '' } : null
  }

  /** Senders and arrival times, for search results that need them. Messages the store doesn't have are left out. */
  heads(ids: string[]): { id: string; from: StoreAddress[]; receivedAt: string }[] {
    const out: { id: string; from: StoreAddress[]; receivedAt: string }[] = []
    for (let i = 0; i < ids.length; i += IN_CHUNK) {
      const chunk = ids.slice(i, i + IN_CHUNK)
      const rows = this.db.exec(`SELECT id, from_json, received_s FROM messages WHERE id IN (${chunk.map(() => '?').join(', ')})`, ...chunk)
      for (const r of rows) out.push({ id: r.id as string, from: JSON.parse(r.from_json as string) as StoreAddress[], receivedAt: fromSeconds(r.received_s as number) })
    }
    return out
  }

  /** Messages and unread messages per folder, to compare with the mail server's own counts. */
  counts(): { folders: FolderCount[]; messages: number } {
    const folders = [...this.db.exec(`SELECT folder_id AS folderId, COUNT(*) AS total, SUM(seen = 0) AS unread FROM placements GROUP BY folder_id`)] as unknown as FolderCount[]
    const messages = [...this.db.exec(`SELECT COUNT(*) AS c FROM messages`)][0]!.c as number
    return { folders, messages }
  }

  /** Size of the store's database in bytes. */
  size(): number {
    return this.db.databaseSize
  }
}
