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
  type StoreFolderRole,
  type StoreListQuery,
  type StoreListRow,
  type StoreMessage,
  type StorePlacement,
  type StoreRow,
} from './query'
import { subjectKey, ulid } from './inbound'
import { planUpdate, type StoreUpdate } from './actions'
import type { ScanState } from './scan-state'

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

/** A message that arrived for the mailbox (mailbox/receive.ts), with what the store keeps of it. */
export type StoreDelivery = {
  /** The new message's id (a ULID, ./inbound.ts), also in its raw copy's key. */
  id: string
  /** SES's id for the message, received or sent; null for a draft. A delivery with an id already here is a repeat. */
  sesId: string | null
  messageId: string | null
  inReplyTo: string | null
  /** The References header's Message-IDs, oldest first. */
  references: string[]
  subject: string
  from: StoreAddress[]
  to: StoreAddress[]
  cc: StoreAddress[]
  /** Mail the mailbox sent: its Bcc recipients, remembered as people it writes to (spam layer 3). */
  bcc?: StoreAddress[]
  /** The mailbox's own addresses, left out when matching a conversation by subject. */
  own: string[]
  preview: string
  /** Readable text for the word index, footer removed. */
  text: string
  receivedAt: string
  size: number
  hasAttachment: boolean
  rawKey: string
  attachments: Omit<StoreAttachment, 'fileId' | 'verified'>[]
  /** SES's spam verdict failed: delivered to Junk. */
  junk: boolean
  /** Mail the mailbox wrote: its Sent copy, or a draft. Received mail leaves this out (Inbox, or Junk). */
  folder?: 'sent' | 'drafts'
  /** Read already: true for the mailbox's own mail. */
  seen?: boolean
  verdicts: Record<string, string>
}

/** A message as the new-mail events read it (`rows`). */
export type StoreEventRow = {
  id: string
  threadId: string
  folder: StoreFolderRole | null
  subject: string
  from: StoreAddress[]
  receivedAt: string
  rawKey: string | null
  hasAttachment: boolean
  draft: boolean
}

/** The message a reply or forward answers, as `replySource` gives it. */
export type StoreReplySource = {
  id: string
  messageId: string | null
  references: string[]
  rawKey: string | null
  attachments: { name: string | null; type: string; size: number; start: number; length: number; encoding: string; scan: ScanState | null; virus: string | null }[]
}

/** A message of a conversation, as `thread` gives it. */
export type StoreThreadMessage = StoreListRow & {
  rawKey: string | null
  rawSize: number | null
  attachments: { start: number; size: number; scan: ScanState | null; virus: string | null }[]
}

/** Where to read an attachment. `length` is -1 when the store has no record of it: look in the raw copy. */
export type StoreAttachmentPlace = { rawKey: string; start: number; length: number; encoding: string; type: string; scan: ScanState | null; virus: string | null }

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

/** A received attachment still `scanning` this long after delivery is scanned again by the hourly catch-up. */
const STUCK_SCAN_SECONDS = 3600

/** How far back a message with the same subject and people joins its conversation, without a reply header. */
const THREAD_BY_SUBJECT_SECONDS = 30 * 24 * 3600

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
    // Mail the store holds itself (phase 2): threading headers, SES's id and verdicts, and IMAP-style numbering.
    const addColumns = (table: string, columns: string[]) => {
      for (const column of columns) {
        try {
          sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column}`)
        } catch {
          // already added
        }
      }
    }
    addColumns('messages', ['message_id TEXT', 'in_reply_to TEXT', 'refs TEXT', 'subject_key TEXT', 'ses_id TEXT', 'verdicts TEXT', 'modseq INTEGER', 'trashed_s INTEGER', 'answered INTEGER', 'forwarded INTEGER', 'is_draft INTEGER'])
    addColumns('placements', ['uid INTEGER'])
    // Virus scanning of received attachments (phase 2 step 4c, ./scan-state.ts): null when not gated.
    addColumns('attachments', ['scan TEXT', 'virus TEXT'])
    addColumns('folders', ['uid_validity INTEGER', 'uid_next INTEGER', 'highest_modseq INTEGER'])
    sql.exec(`CREATE INDEX IF NOT EXISTS messages_message_id ON messages (message_id) WHERE message_id IS NOT NULL`)
    sql.exec(`CREATE UNIQUE INDEX IF NOT EXISTS messages_ses_id ON messages (ses_id) WHERE ses_id IS NOT NULL`)
    sql.exec(`CREATE INDEX IF NOT EXISTS messages_subject_key ON messages (subject_key, received_s) WHERE subject_key IS NOT NULL`)
    // Spam layer 3 (phase 2 step 4b): who the mailbox has written to, and its people's verdicts on senders.
    sql.exec(`CREATE TABLE IF NOT EXISTS correspondents (address TEXT PRIMARY KEY, last_s INTEGER NOT NULL) WITHOUT ROWID`)
    sql.exec(`CREATE TABLE IF NOT EXISTS sender_verdicts (address TEXT PRIMARY KEY, verdict TEXT NOT NULL, at_s INTEGER NOT NULL) WITHOUT ROWID`)
    // Sent mail from before the table existed, once.
    if (this.meta('owner') === 'store' && this.meta('correspondents_filled') !== '1') {
      for (const row of sql.exec(`SELECT to_json, received_s FROM messages WHERE folder = 'sent'`)) {
        this.wroteTo((JSON.parse(row.to_json as string) as StoreAddress[]).map((a) => a.email), row.received_s as number)
      }
      this.setMeta('correspondents_filled', '1')
    }
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
    // A store that holds the mail itself is the only copy of its folders and flags: never emptied by the shadow copy.
    if (this.meta('owner') === 'store') throw new Error('This store holds its own mail and is not reset')
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
      attachments: [...this.db.exec(`SELECT start, size, scan, virus FROM attachments WHERE n = ? ORDER BY seq`, row.n)] as unknown as StoreThreadMessage['attachments'],
    }))
  }

  /** Where an attachment sits: its message's raw copy and the encoded range, found by the range's start. */
  attachmentAt(emailId: string, start: number): StoreAttachmentPlace | null {
    const row = [...this.db.exec(
      `SELECT m.raw_key AS rawKey, a.start, a.length, a.encoding, a.type, a.scan, a.virus FROM messages m JOIN attachments a ON a.n = m.n
        WHERE m.id = ? AND a.start = ?`,
      emailId, start,
    )][0] as StoreAttachmentPlace | undefined
    if (row) return row
    // Not recorded (or recorded under another part): the caller can still find it in the raw copy.
    const msg = [...this.db.exec(`SELECT raw_key AS rawKey FROM messages WHERE id = ?`, emailId)][0] as { rawKey: string | null } | undefined
    return msg?.rawKey ? { rawKey: msg.rawKey, start, length: -1, encoding: '', type: '', scan: null, virus: null } : null
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

  // -------------------------------------------------------------------------------------------------------------
  // Mail the store holds itself (docs/mailbox-store-plan.md, phase 2): delivered by mailbox/receive.ts, not copied.

  /** The message delivered with SES's id `sesId`, if there is one: a retried delivery finds it and stops. */
  findBySes(sesId: string): { id: string; threadId: string } | null {
    const row = [...this.db.exec(`SELECT id, thread_id FROM messages WHERE ses_id = ?`, sesId)][0] as { id: string; thread_id: string } | undefined
    return row ? { id: row.id, threadId: row.thread_id } : null
  }

  /**
   * Makes this store the holder of its mailbox's mail, with its own six folders, the first time. Refuses a store that
   * holds a shadow copy of Stalwart: moving copied mail over is phase 4.
   */
  private ensureOwned(): Map<string, string> {
    if (this.meta('owner') !== 'store') {
      const copied = [...this.db.exec(`SELECT COUNT(*) AS c FROM messages`)][0]!.c as number
      if (copied || this.meta('state')) throw new Error('This store holds a copy of Stalwart mail; it cannot take delivered mail')
      this.db.exec(`DELETE FROM folders`)
      const names: [StoreFolderRole, string][] = [['inbox', 'Inbox'], ['sent', 'Sent'], ['drafts', 'Drafts'], ['archive', 'Archive'], ['junk', 'Junk'], ['trash', 'Trash']]
      for (const [role, name] of names) {
        const validity = crypto.getRandomValues(new Uint32Array(1))[0]! & 0x7fffffff || 1
        this.db.exec(`INSERT INTO folders (id, role, name, uid_validity, uid_next, highest_modseq) VALUES (?, ?, ?, ?, 1, 0)`, ulid(), role, name, validity)
      }
      this.setMeta('owner', 'store')
      this.setMeta('modseq', '0')
    }
    const byRole = new Map<string, string>()
    for (const f of this.db.exec(`SELECT id, role FROM folders WHERE role IS NOT NULL`)) byRole.set(f.role as string, f.id as string)
    return byRole
  }

  /** The next value of the mailbox-wide change counter: every change gets one, so syncing can ask "what changed since". */
  private nextModseq(): number {
    const next = Number(this.meta('modseq') ?? '0') + 1
    this.setMeta('modseq', String(next))
    return next
  }

  /**
   * Stores a message that arrived for this mailbox, in one transaction: its folder (Inbox, or Junk), its thread, its
   * IMAP numbering and its search rows. Delivering the same SES message again changes nothing and returns the first.
   */
  deliver(d: StoreDelivery): { id: string; threadId: string; folder: StoreFolderRole; duplicate: boolean } {
    return this.ctx.storage.transactionSync(() => {
      const role: StoreFolderRole = d.folder ?? (d.junk ? 'junk' : 'inbox')
      const existing = d.sesId ? this.findBySes(d.sesId) : null
      if (existing) return { ...existing, folder: role, duplicate: true }
      const folders = this.ensureOwned()
      const folderId = folders.get(role)!
      const threadId = this.threadFor(d) ?? ulid()
      this.upsertOne({
        id: d.id,
        threadId,
        folderIds: [folderId],
        folder: role,
        seen: !!d.seen,
        pinned: false,
        from: d.from,
        to: d.to,
        subject: d.subject,
        preview: d.preview,
        receivedAt: d.receivedAt,
        size: d.size,
        hasAttachment: d.hasAttachment,
        text: d.text,
      })
      const n = [...this.db.exec(`SELECT n FROM messages WHERE id = ?`, d.id)][0]!.n as number
      const modseq = this.nextModseq()
      this.db.exec(
        `UPDATE messages SET message_id = ?, in_reply_to = ?, refs = ?, subject_key = ?, ses_id = ?, verdicts = ?, modseq = ?,
          raw_key = ?, raw_size = ?, parse_diff = '', is_draft = ? WHERE n = ?`,
        d.messageId, d.inReplyTo, d.references.join(' ') || null, subjectKey(d.subject), d.sesId, JSON.stringify(d.verdicts), modseq,
        d.rawKey, d.size, d.folder === 'drafts' ? 1 : 0, n,
      )
      const folder = [...this.db.exec(`SELECT uid_next FROM folders WHERE id = ?`, folderId)][0] as { uid_next: number }
      this.db.exec(`UPDATE placements SET uid = ? WHERE folder_id = ? AND n = ?`, folder.uid_next, folderId, n)
      this.db.exec(`UPDATE folders SET uid_next = uid_next + 1, highest_modseq = ? WHERE id = ?`, modseq, folderId)
      if (d.folder === 'sent') this.wroteTo([...d.to, ...d.cc, ...(d.bcc ?? [])].map((a) => a.email), Math.floor(Date.parse(d.receivedAt) / 1000))
      d.attachments.forEach((a, seq) => {
        this.db.exec(
          `INSERT INTO attachments (n, seq, file_id, name, type, size, start, length, encoding, verified, scan) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, NULL, ?)`,
          n, seq, a.name, a.type, a.size, a.start, a.length, a.encoding, d.folder ? null : 'scanning',
        )
      })
      return { id: d.id, threadId, folder: role, duplicate: false }
    })
  }

  /**
   * The conversation a new message belongs to: the newest message it replies to (In-Reply-To, then References from
   * the latest back), else a recent message with the same subject that shares someone besides the mailbox itself.
   */
  private threadFor(d: StoreDelivery): string | null {
    const replyTo = [...(d.inReplyTo ? [d.inReplyTo] : []), ...[...d.references].reverse()]
    for (const id of replyTo) {
      const row = [...this.db.exec(`SELECT thread_id FROM messages WHERE message_id = ? ORDER BY n DESC LIMIT 1`, id)][0]
      if (row) return row.thread_id as string
    }
    const key = subjectKey(d.subject)
    if (!key) return null
    const own = new Set(d.own.map((a) => a.toLowerCase()))
    const people = new Set([...d.from, ...d.to, ...d.cc].map((a) => a.email.toLowerCase()).filter((a) => !own.has(a)))
    if (!people.size) return null
    const since = Math.floor(Date.parse(d.receivedAt) / 1000) - THREAD_BY_SUBJECT_SECONDS
    const candidates = this.db.exec(
      `SELECT thread_id, from_addr, to_json FROM messages WHERE subject_key = ? AND received_s >= ? ORDER BY received_s DESC LIMIT 20`,
      key, since,
    )
    for (const c of candidates) {
      const theirs = [c.from_addr as string, ...(JSON.parse(c.to_json as string) as StoreAddress[]).map((a) => a.email.toLowerCase())]
      if (theirs.some((a) => people.has(a))) return c.thread_id as string
    }
    return null
  }

  /**
   * Marks read or unread, pins, or moves (archive, inbox, junk, trash) a message or its conversation
   * (email_update_message), in one transaction. Each changed message gets the next modseq; a moved one leaves its
   * folder and gets a new uid in the target, as an IMAP move. `found` is false when the message isn't here.
   */
  update(u: StoreUpdate): { found: boolean; changed: number; changedIds: string[]; moved: boolean } {
    if (this.meta('owner') !== 'store') throw new Error('This store does not hold its own mail')
    return this.ctx.storage.transactionSync(() => {
      const chosen = [...this.db.exec(`SELECT thread_id FROM messages WHERE id = ?`, u.id)][0] as { thread_id: string } | undefined
      if (!chosen) return { found: false, changed: 0, changedIds: [], moved: false }
      const rows = [...this.db.exec(
        `SELECT n, id, folder, seen, pinned FROM messages WHERE ${u.thread ? 'thread_id = ?' : 'id = ?'}`,
        u.thread ? chosen.thread_id : u.id,
      )].map((r) => ({ n: r.n as number, id: r.id as string, folder: r.folder as StoreFolderRole | null, seen: !!r.seen, pinned: !!r.pinned }))
      const plan = planUpdate(rows, u) ?? []
      const folderIds = this.ensureOwned()
      const now = Math.floor(Date.now() / 1000)
      for (const c of plan) {
        const modseq = this.nextModseq()
        const touched = new Set(([...this.db.exec(`SELECT folder_id FROM placements WHERE n = ?`, c.n)] as { folder_id: string }[]).map((p) => p.folder_id))
        if (c.seen !== undefined) {
          this.db.exec(`UPDATE messages SET seen = ? WHERE n = ?`, c.seen ? 1 : 0, c.n)
          this.db.exec(`UPDATE placements SET seen = ? WHERE n = ?`, c.seen ? 1 : 0, c.n)
        }
        if (c.pinned !== undefined) this.db.exec(`UPDATE messages SET pinned = ? WHERE n = ?`, c.pinned ? 1 : 0, c.n)
        if (c.folder) {
          // "Junk" and "Not junk": a move between Inbox and Junk is the mailbox's verdict on the sender (spam layer 3).
          const before = rows.find((r) => r.n === c.n)?.folder
          if (!u.system && ((before === 'inbox' && c.folder === 'junk') || (before === 'junk' && c.folder === 'inbox'))) {
            const sender = [...this.db.exec(`SELECT from_addr FROM messages WHERE n = ?`, c.n)][0]?.from_addr as string | undefined
            if (sender) {
              this.db.exec(
                `INSERT OR REPLACE INTO sender_verdicts (address, verdict, at_s) VALUES (?, ?, ?)`,
                sender, c.folder === 'junk' ? 'junk' : 'notjunk', now,
              )
            }
          }
          const target = folderIds.get(c.folder)
          if (!target) throw new Error(`No ${c.folder} folder`)
          const row = [...this.db.exec(`SELECT received_s, seen FROM messages WHERE n = ?`, c.n)][0] as { received_s: number; seen: number }
          const uid = ([...this.db.exec(`SELECT uid_next FROM folders WHERE id = ?`, target)][0] as { uid_next: number }).uid_next
          this.db.exec(`DELETE FROM placements WHERE n = ?`, c.n)
          this.db.exec(`INSERT INTO placements (folder_id, received_s, n, seen, uid) VALUES (?, ?, ?, ?, ?)`, target, row.received_s, c.n, row.seen, uid)
          this.db.exec(`UPDATE folders SET uid_next = uid_next + 1 WHERE id = ?`, target)
          this.db.exec(`UPDATE messages SET folder = ?, trashed_s = ? WHERE n = ?`, c.folder, c.folder === 'trash' ? now : null, c.n)
          touched.add(target)
        }
        this.db.exec(`UPDATE messages SET modseq = ? WHERE n = ?`, modseq, c.n)
        for (const folderId of touched) this.db.exec(`UPDATE folders SET highest_modseq = ? WHERE id = ?`, modseq, folderId)
      }
      const ids = new Map(rows.map((r) => [r.n, r.id]))
      return { found: true, changed: plan.length, changedIds: plan.map((c) => ids.get(c.n)!), moved: plan.some((c) => !!c.folder) }
    })
  }

  /**
   * Deletes for good the messages that have been in Trash since before `before` (seconds), at most `limit` of them.
   * Returns their raw copies' keys, for the caller to delete from the bucket.
   */
  purgeTrash(before: number, limit = 500): { purged: number; rawKeys: string[]; ids: string[] } {
    if (this.meta('owner') !== 'store') return { purged: 0, rawKeys: [], ids: [] }
    const ids = [...this.db.exec(`SELECT id FROM messages WHERE folder = 'trash' AND trashed_s < ? LIMIT ?`, before, limit)].map((r) => r.id as string)
    if (!ids.length) return { purged: 0, rawKeys: [], ids: [] }
    const gone = this.remove(ids)
    this.nextModseq()
    return { purged: gone.removed, rawKeys: gone.rawKeys, ids }
  }

  /**
   * What a reply or forward needs from the message it answers: its Message-ID and References, for threading, and
   * where its raw copy and its files are, for a forward. Null when the message isn't here.
   */
  replySource(id: string): StoreReplySource | null {
    const row = [...this.db.exec(`SELECT n, message_id, refs, raw_key FROM messages WHERE id = ?`, id)][0] as
      | { n: number; message_id: string | null; refs: string | null; raw_key: string | null }
      | undefined
    if (!row) return null
    const attachments = [...this.db.exec(`SELECT name, type, size, start, length, encoding, scan, virus FROM attachments WHERE n = ? ORDER BY seq`, row.n)] as unknown as StoreReplySource['attachments']
    return { id, messageId: row.message_id, references: row.refs ? row.refs.split(' ') : [], rawKey: row.raw_key, attachments }
  }

  /** Marks the message a reply or forward was sent for (kept for IMAP's \\Answered and $Forwarded; shown nowhere yet). */
  markOriginal(id: string, kind: 'answered' | 'forwarded') {
    const n = [...this.db.exec(`SELECT n FROM messages WHERE id = ?`, id)][0]?.n as number | undefined
    if (n === undefined) return
    this.db.exec(`UPDATE messages SET ${kind === 'answered' ? 'answered' : 'forwarded'} = 1, modseq = ? WHERE n = ?`, this.nextModseq(), n)
  }

  /** A draft's threading headers, or null when `id` isn't a draft in Drafts (sent or deleted meanwhile). */
  draft(id: string): { inReplyTo: string | null; references: string[] } | null {
    const row = [...this.db.exec(`SELECT in_reply_to, refs FROM messages WHERE id = ? AND is_draft = 1 AND folder = 'drafts'`, id)][0] as
      | { in_reply_to: string | null; refs: string | null }
      | undefined
    return row ? { inReplyTo: row.in_reply_to, references: row.refs ? row.refs.split(' ') : [] } : null
  }

  /** Deletes a draft that was sent or replaced. Returns its raw copy's key, for the caller to delete. */
  removeDraft(id: string): string[] {
    const isDraft = [...this.db.exec(`SELECT 1 FROM messages WHERE id = ? AND is_draft = 1`, id)].length > 0
    if (!isDraft) return []
    const gone = this.remove([id])
    this.nextModseq()
    return gone.rawKeys
  }

  /** Records addresses the mailbox has written to, at `at` (seconds). */
  private wroteTo(addresses: string[], at: number) {
    for (const a of new Set(addresses.map((x) => x.trim().toLowerCase()).filter(Boolean))) {
      this.db.exec(`INSERT INTO correspondents (address, last_s) VALUES (?, ?) ON CONFLICT (address) DO UPDATE SET last_s = MAX(last_s, excluded.last_s)`, a, at)
    }
  }

  /** What the mailbox knows of a sender, for the spam decision (./spam.ts): written to before, and its verdict. */
  standing(address: string): { wrote: boolean; verdict: 'junk' | 'notjunk' | null } {
    const a = address.trim().toLowerCase()
    const wrote = [...this.db.exec(`SELECT 1 FROM correspondents WHERE address = ?`, a)].length > 0
    const verdict = ([...this.db.exec(`SELECT verdict FROM sender_verdicts WHERE address = ?`, a)][0]?.verdict as 'junk' | 'notjunk' | undefined) ?? null
    return { wrote, verdict }
  }

  /** What the new-mail events (./events.ts) need of each message; ones that are gone are left out. */
  rows(ids: string[]): StoreEventRow[] {
    const out: StoreEventRow[] = []
    for (let i = 0; i < ids.length; i += IN_CHUNK) {
      const chunk = ids.slice(i, i + IN_CHUNK)
      const rows = this.db.exec(
        `SELECT id, thread_id, folder, subject, from_json, received_s, raw_key, has_attachment, is_draft FROM messages WHERE id IN (${chunk.map(() => '?').join(', ')})`,
        ...chunk,
      )
      for (const r of rows) {
        out.push({
          id: r.id as string,
          threadId: r.thread_id as string,
          folder: r.folder as StoreFolderRole | null,
          subject: r.subject as string,
          from: JSON.parse(r.from_json as string) as StoreAddress[],
          receivedAt: fromSeconds(r.received_s as number),
          rawKey: r.raw_key as string | null,
          hasAttachment: !!r.has_attachment,
          draft: !!r.is_draft,
        })
      }
    }
    return out
  }

  /** Every message's id, oldest first, for the one-time catch-up of mail that arrived before events existed. */
  allIds(): string[] {
    return [...this.db.exec(`SELECT id FROM messages ORDER BY n`)].map((r) => r.id as string)
  }

  /** Whether the one-time catch-up ran (`set` marks it done). Only stores that hold their own mail use it. */
  caughtUp(set = false): boolean {
    if (set) this.setMeta('events_caught_up', '1')
    return this.meta('owner') !== 'store' || this.meta('events_caught_up') === '1'
  }

  /** Records virus-scan results for a message's attachments, by their start in the raw copy; the apps reload. */
  setScan(emailId: string, results: { start: number; state: ScanState; virus: string | null }[]) {
    const n = [...this.db.exec(`SELECT n FROM messages WHERE id = ?`, emailId)][0]?.n as number | undefined
    if (n === undefined || !results.length) return
    this.ctx.storage.transactionSync(() => {
      for (const r of results) this.db.exec(`UPDATE attachments SET scan = ?, virus = ? WHERE n = ? AND start = ?`, r.state, r.virus, n, r.start)
      this.db.exec(`UPDATE messages SET modseq = ? WHERE n = ?`, this.nextModseq(), n)
    })
  }

  /**
   * Received messages whose attachments need a scan: never scanned (from before scanning existed), or still
   * `scanning` after `stuckSeconds` (an event that never ran would otherwise leave them blocked for good).
   */
  unscanned(stuckSeconds = STUCK_SCAN_SECONDS, limit = 500): string[] {
    const before = Math.floor(Date.now() / 1000) - stuckSeconds
    return [...this.db.exec(
      `SELECT DISTINCT m.id FROM messages m JOIN attachments a ON a.n = m.n
        WHERE (a.scan IS NULL OR (a.scan = 'scanning' AND m.received_s < ?)) AND m.folder IS NOT 'sent' AND m.is_draft IS NOT 1 LIMIT ?`,
      before, limit,
    )].map((r) => r.id as string)
  }

  /** Folders with their counts, for a mailbox whose mail the store holds (email_list_folders). */
  folderList(): { id: string; role: string | null; name: string; total: number; unread: number }[] {
    return [...this.db.exec(
      `SELECT f.id, f.role, f.name, COUNT(p.n) AS total, COALESCE(SUM(p.seen = 0), 0) AS unread
        FROM folders f LEFT JOIN placements p ON p.folder_id = f.id GROUP BY f.id ORDER BY f.rowid`,
    )] as unknown as { id: string; role: string | null; name: string; total: number; unread: number }[]
  }

  /** A token that changes whenever the mailbox's mail changes: the apps poll it and reload when it differs. */
  changeState(): string {
    return this.meta('modseq') ?? '0'
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
