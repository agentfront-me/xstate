// One mail app's IMAP connection (docs/imap-smtp-relay-plan.md §6). The mail bridge hands the connection over as a
// WebSocket: binary frames are the connection's bytes, text frames are control ("ack <n>" from the bridge, "close"
// to it; see services/mail-bridge/main.go). The session speaks IMAP4rev1 and answers from the mailbox's store
// (mailbox/store.ts) and its raw messages in R2. Nothing of the mail is kept here.
//
// PHASE 3: reading. Every folder opens read-only; changing flags, moving, deleting and saving messages arrive with
// phase 4, and until then those commands are refused.
//
// State. The socket hibernates between commands, so nothing that matters lives only in memory:
//   - the socket's attachment (at most 16 KB): who is signed in, the open folder's numbers, IDLE, the byte counts;
//   - this object's storage: the open folder's UID list (it turns message sequence numbers into UIDs) and any half
//     of a command that has arrived.
// Storage is deleted when the connection closes, or by an alarm if the bridge dies without closing.
//
// Order. Commands are handled one at a time. While one is being answered (a large FETCH waits for the bridge's acks,
// so a slow mail app can't fill memory), bytes that arrive are only queued.

import { DurableObject } from 'cloudflare:workers'
import { appAccess, authenticateApp } from '../auth/app-passwords'
import { decodeName, encodeName, matches } from '../imap/names.ts'
import { describe, envelope, parseFields, pickFields, quote, section, type ImapMeta } from '../imap/message.ts'
import { queueImapPrepare } from '../imap/prepare'
import { parseSearch, resolveSequences, type Criterion } from '../imap/search.ts'
import { nextCommand, parseSet, text, type Command, type Token } from '../imap/syntax.ts'
import type { ImapFolder, ImapRow } from '../mailbox/store'
import { store } from '../mailbox/stub'
import { organizationBucket } from '../storage/buckets'
import { getObject, getObjectRange } from '../storage/r2'

const FRAME = 64 * 1024
/** Most bytes sent ahead of the bridge's last ack. The bridge acks every 256 KB, so this can't stall. */
const WINDOW = 1024 * 1024
const DAY_MS = 24 * 60 * 60 * 1000
/** How long a FETCH waits for a mail app that has stopped reading before the connection is dropped. */
const STALL_MS = 10 * 60 * 1000
/** UIDs per storage row (1 MB of 4-byte numbers). */
const UIDS_PER_ROW = 262144
/** Messages asked of the store at a time: more when only flags are wanted, fewer when each row carries its headers. */
const ROWS_PLAIN = 1000
const ROWS_WITH_META = 100
/** Section reads from R2 at once, when every section is small. */
const PARALLEL = 6
const SMALL_SECTION = 256 * 1024
const MAX_BAD = 10

const CAPABILITIES = 'IMAP4rev1 SASL-IR ID ENABLE IDLE NAMESPACE UNSELECT SPECIAL-USE CONDSTORE'
const FLAGS = '\\Answered \\Flagged \\Draft \\Deleted \\Seen $Forwarded'
const SPECIAL: Record<string, string> = { sent: '\\Sent', drafts: '\\Drafts', archive: '\\Archive', junk: '\\Junk', trash: '\\Trash' }

type Auth = { passwordId: string; userId: string; organizationId: string; mailboxId: string; address: string; canWrite: boolean }
type Selected = { folderId: string; name: string; uidValidity: number; uidNext: number; modseq: number; total: number }

/** What survives hibernation with the socket (at most 16 KB). */
type State = {
  ip: string
  auth: Auth | null
  selected: Selected | null
  /** The tag of the IDLE command the session is in, or null. */
  idleTag: string | null
  /** The tag of an AUTHENTICATE PLAIN waiting for its answer line. */
  authTag: string | null
  /** The mail app asked for change numbers (ENABLE CONDSTORE, or a CONDSTORE option): FETCH answers carry MODSEQ. */
  condstore: boolean
  /** Bytes sent to the bridge, and how many of them it says the mail app has taken. */
  sent: number
  acked: number
  /** Commands that couldn't be read; too many and the connection is closed. */
  bad: number
  /** Whether half a command is waiting in storage. */
  stored: boolean
}

/** One FETCH data item, as asked. */
type Item =
  | { kind: 'uid' | 'flags' | 'internaldate' | 'size' | 'envelope' | 'structure' | 'modseq'; label: string }
  | { kind: 'body'; label: string; spec: string; partial: [number, number] | null }

class Closed extends Error {}

const utf8 = new TextDecoder()
const latin1 = new TextDecoder('latin1')
const toBytes = (s: string) => {
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff
  return out
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const pad = (n: number) => String(n).padStart(2, '0')
function internalDate(seconds: number): string {
  const d = new Date(seconds * 1000)
  return `"${pad(d.getUTCDate())}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} +0000"`
}
const flagsOf = (r: Pick<ImapRow, 'seen' | 'answered' | 'pinned' | 'draft' | 'forwarded'>) =>
  [r.seen && '\\Seen', r.answered && '\\Answered', r.pinned && '\\Flagged', r.draft && '\\Draft', r.forwarded && '$Forwarded'].filter(Boolean).join(' ')
const folderName = (f: Pick<ImapFolder, 'role' | 'name'>) => (f.role === 'inbox' ? 'INBOX' : f.name)
const fromBase64 = (value: string): string | null => {
  try {
    return utf8.decode(Uint8Array.from(atob(value.trim()), (c) => c.charCodeAt(0)))
  } catch {
    return null
  }
}

export class ImapSession extends DurableObject<Env> {
  /** Bytes received and not yet read as commands. Null until loaded (after hibernation, from storage). */
  private input: Uint8Array | null = null
  private busy = false
  /** The mailbox changed while a command was being answered: look again when it is done. */
  private syncWanted = false
  /** The open folder's UIDs, ascending. Null until loaded. */
  private uids: Uint32Array | null = null
  private sent = 0
  private acked = 0
  private waiters: (() => void)[] = []
  /** Where the literal already answered with "+" was announced, so it isn't answered twice. */
  private prompted = -1
  private bucket: string | null = null

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value BLOB NOT NULL) WITHOUT ROWID`)
  }

  /** A new connection from the bridge, already checked by relay/route.ts. */
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 })
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket]
    this.ctx.acceptWebSocket(server)
    const greeting = toBytes(`* OK [CAPABILITY ${CAPABILITIES} AUTH=PLAIN] xstate IMAP ready\r\n`)
    server.send(greeting)
    const state: State = {
      ip: new URL(request.url).searchParams.get('ip') ?? '',
      auth: null, selected: null, idleTag: null, authTag: null, condstore: false, sent: greeting.length, acked: 0, bad: 0, stored: false,
    }
    server.serializeAttachment(state)
    await this.ctx.storage.setAlarm(Date.now() + DAY_MS)
    return new Response(null, { status: 101, webSocket: client })
  }

  override async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string) {
    if (typeof message === 'string') {
      const acked = /^ack (\d+)$/.exec(message)
      if (!acked) return
      this.acked = Math.max(this.acked, Number(acked[1]))
      if (this.busy) for (const wake of this.waiters.splice(0)) wake()
      else {
        const state = ws.deserializeAttachment() as State
        state.acked = Math.max(state.acked, this.acked)
        ws.serializeAttachment(state)
      }
      return
    }
    const state = ws.deserializeAttachment() as State
    if (this.input === null) this.input = state.stored ? this.loadBlob('input') : new Uint8Array(0)
    const bytes = new Uint8Array(message)
    const joined = new Uint8Array(this.input.length + bytes.length)
    joined.set(this.input)
    joined.set(bytes, this.input.length)
    this.input = joined
    if (this.busy) return
    await this.work(ws, (s) => this.read(ws, s))
  }

  override async webSocketClose(ws: WebSocket) {
    await this.forget(ws)
  }

  override async webSocketError(ws: WebSocket) {
    await this.forget(ws)
  }

  /** Daily: a session whose bridge vanished without closing is cleaned up; a live one is checked again tomorrow. */
  override async alarm() {
    const ws = this.ctx.getWebSockets()[0]
    if (ws) await this.ctx.storage.setAlarm(Date.now() + DAY_MS)
    else await this.forget(undefined)
  }

  /**
   * Called by the mailbox's store when something in the mailbox changed. True while the session is waiting for
   * news (in IDLE); false tells the store to stop calling.
   */
  async changed(): Promise<boolean> {
    const ws = this.ctx.getWebSockets()[0]
    if (!ws) return false
    if (this.busy) {
      this.syncWanted = true
      return true
    }
    const state = ws.deserializeAttachment() as State
    if (!state.idleTag || !state.selected) return false
    await this.work(ws, (s) => this.sync(ws, s))
    return true
  }

  /** Runs one piece of work with the session's counters loaded, then saves the state back with the socket. */
  private async work(ws: WebSocket, job: (state: State) => Promise<void>) {
    this.busy = true
    const state = ws.deserializeAttachment() as State
    this.sent = state.sent
    this.acked = Math.max(this.acked, state.acked)
    try {
      await job(state)
      while (this.syncWanted) {
        this.syncWanted = false
        if (state.idleTag && state.selected) await this.sync(ws, state)
      }
    } catch (err) {
      if (!(err instanceof Closed)) {
        console.error('imap: session failed', err)
        try {
          ws.send(toBytes('* BYE Something went wrong. Connect again.\r\n'))
          ws.send('close')
        } catch {
          // already gone
        }
      }
      this.busy = false
      return
    }
    state.sent = this.sent
    state.acked = this.acked
    // Half a command stays in storage, so it is still here if the object sleeps before the rest arrives.
    const left = this.input ?? new Uint8Array(0)
    if (left.length) this.saveBlob('input', left)
    else if (state.stored) this.ctx.storage.sql.exec(`DELETE FROM kv WHERE key = 'input'`)
    state.stored = left.length > 0
    ws.serializeAttachment(state)
    this.busy = false
  }

  // -------------------------------------------------------------------------------------------------------------
  // Reading commands

  private async read(ws: WebSocket, state: State) {
    for (;;) {
      const input = this.input!
      // Two moments when the next line is not a command: the answer to AUTHENTICATE, and DONE ending an IDLE.
      if (state.authTag || state.idleTag) {
        const end = input.indexOf(10)
        if (end < 0) return
        const line = latin1.decode(input.subarray(0, end)).replace(/\r$/, '')
        this.input = input.subarray(end + 1)
        if (state.authTag) {
          const tag = state.authTag
          state.authTag = null
          if (line === '*') await this.say(ws, `${tag} BAD Sign-in cancelled`)
          else await this.signInPlain(ws, state, tag, line)
        } else if (line.toUpperCase() === 'DONE') {
          const tag = state.idleTag!
          state.idleTag = null
          if (state.auth) await (await store(this.env, state.auth.mailboxId)).unwatch(this.ctx.id.toString())
          await this.say(ws, `${tag} OK IDLE done`)
        }
        continue
      }
      const next = nextCommand(input)
      if (next.kind === 'more') return
      if (next.kind === 'literal') {
        if (!next.sync || this.prompted === next.announcedAt) return
        // Saving a message (APPEND) isn't available yet: refuse before the mail app sends it.
        const head = latin1.decode(input.subarray(0, Math.min(next.announcedAt, 200))).split(' ')
        if (head[1]?.toUpperCase() === 'APPEND') {
          this.input = input.subarray(next.announcedAt)
          await this.say(ws, `${head[0]} NO [CANNOT] Saving messages from a mail app isn't available yet`)
          continue
        }
        this.prompted = next.announcedAt
        await this.say(ws, '+ Ready')
        return
      }
      this.prompted = -1
      this.input = input.subarray(next.consumed)
      if (next.kind === 'bad') {
        await this.say(ws, `${next.tag} BAD ${next.reason}`)
        if (++state.bad > MAX_BAD) return this.end(ws, '* BYE Too many commands that could not be read')
        continue
      }
      await this.command(ws, state, next.command)
    }
  }

  private async command(ws: WebSocket, state: State, c: Command): Promise<void> {
    const ok = (what: string) => this.say(ws, `${c.tag} OK ${what}`)
    const no = (what: string) => this.say(ws, `${c.tag} NO ${what}`)
    const bad = (what: string) => this.say(ws, `${c.tag} BAD ${what}`)
    let name = c.name
    let args = c.args
    const byUid = name === 'UID'
    if (byUid) {
      name = text(args[0])?.toUpperCase() ?? ''
      args = args.slice(1)
    }

    switch (name) {
      case 'CAPABILITY':
        await this.say(ws, `* CAPABILITY ${CAPABILITIES}${state.auth ? '' : ' AUTH=PLAIN'}`)
        return ok('CAPABILITY done')
      case 'NOOP':
      case 'CHECK':
        if (state.selected) await this.sync(ws, state)
        return ok(`${name} done`)
      case 'ID':
        await this.say(ws, '* ID ("name" "xstate")')
        return ok('ID done')
      case 'LOGOUT':
        await this.say(ws, '* BYE Logging out', `${c.tag} OK LOGOUT done`)
        return this.end(ws, '')
      case 'STARTTLS':
        return bad('The connection is already encrypted')
      case 'LOGIN': {
        if (state.auth) return bad('Already signed in')
        return this.signIn(ws, state, c.tag, text(args[0]) ?? '', text(args[1]) ?? '')
      }
      case 'AUTHENTICATE': {
        if (state.auth) return bad('Already signed in')
        if (text(args[0])?.toUpperCase() !== 'PLAIN') return no('Use AUTHENTICATE PLAIN or LOGIN')
        const initial = text(args[1])
        if (initial && initial !== '=') return this.signInPlain(ws, state, c.tag, initial)
        state.authTag = c.tag
        return this.say(ws, '+ ')
      }
    }

    const auth = state.auth
    if (!auth) return no('Sign in first')
    const stub = await store(this.env, auth.mailboxId)

    switch (name) {
      case 'ENABLE': {
        const on = args.some((a) => text(a)?.toUpperCase() === 'CONDSTORE')
        if (on) state.condstore = true
        await this.say(ws, on ? '* ENABLED CONDSTORE' : '* ENABLED')
        return ok('ENABLE done')
      }
      case 'NAMESPACE':
        await this.say(ws, '* NAMESPACE (("" "/")) NIL NIL')
        return ok('NAMESPACE done')
      case 'LIST':
      case 'LSUB':
      case 'XLIST': {
        // LIST (selection options) ref pattern [RETURN (...)]: the options are ignored, special-use is always sent.
        const rest = args[0]?.t === 'list' ? args.slice(1) : args
        const pattern = (text(rest[0]) ?? '') + (text(rest[1]) ?? '')
        if (rest[1]?.t === 'list') return bad('One pattern at a time')
        if (!text(rest[1])) {
          await this.say(ws, `* ${name} (\\Noselect) "/" ""`)
          return ok(`${name} done`)
        }
        const folders = await stub.imapFolders()
        const names = folders.map(folderName)
        const lines = folders
          .filter((f) => matches(decodeName(pattern), folderName(f)))
          .map((f) => {
            const own = folderName(f)
            const attrs = [names.some((n) => n.startsWith(`${own}/`)) ? '\\HasChildren' : '\\HasNoChildren', f.role ? SPECIAL[f.role] : ''].filter(Boolean)
            return `* ${name} (${attrs.join(' ')}) "/" ${quote(encodeName(own))}`
          })
        if (lines.length) await this.say(ws, ...lines)
        return ok(`${name} done`)
      }
      case 'STATUS': {
        const folder = await this.folder(stub, text(args[0]))
        if (!folder || args[1]?.t !== 'list') return no('No such folder')
        const values: Record<string, number> = {
          MESSAGES: folder.total, RECENT: 0, UIDNEXT: folder.uidNext, UIDVALIDITY: folder.uidValidity, UNSEEN: folder.unseen, HIGHESTMODSEQ: folder.highestModseq,
        }
        const items = args[1].items.map((i) => text(i)?.toUpperCase() ?? '').filter((i) => i in values)
        await this.say(ws, `* STATUS ${quote(encodeName(folderName(folder)))} (${items.map((i) => `${i} ${values[i]}`).join(' ')})`)
        return ok('STATUS done')
      }
      case 'SELECT':
      case 'EXAMINE': {
        // Access is checked again every time a folder is opened, so a change made in the app takes effect now.
        const access = await appAccess(this.env, auth)
        if (!access) return this.end(ws, '* BYE Access to this mailbox has ended')
        auth.canWrite = access === 'write'
        this.forgetFolder(state)
        const folder = await this.folder(stub, text(args[0]))
        const opened = folder && (await stub.imapOpen(folder.id))
        if (!opened) return no('No such folder')
        // Old mail not yet made ready for mail apps: start that in the background (imap/prepare.ts).
        if (opened.unprepared > ROWS_WITH_META) await queueImapPrepare(this.env, auth.mailboxId)
        if (args[1]?.t === 'list' && args[1].items.some((i) => text(i)?.toUpperCase() === 'CONDSTORE')) state.condstore = true
        this.setUids(Uint32Array.from(opened.uids))
        state.selected = { folderId: opened.id, name: folderName(opened), uidValidity: opened.uidValidity, uidNext: opened.uidNext, modseq: opened.highestModseq, total: opened.uids.length }
        await this.say(
          ws,
          `* FLAGS (${FLAGS})`,
          "* OK [PERMANENTFLAGS ()] Flags can't be changed from a mail app yet",
          `* ${opened.uids.length} EXISTS`,
          '* 0 RECENT',
          `* OK [UIDVALIDITY ${opened.uidValidity}] UIDs valid`,
          `* OK [UIDNEXT ${opened.uidNext}] Next UID`,
          `* OK [HIGHESTMODSEQ ${opened.highestModseq}] Highest change number`,
        )
        return ok(`[READ-ONLY] ${name} done`)
      }
      case 'SUBSCRIBE':
      case 'UNSUBSCRIBE':
        return ok(`${name} done`)
      case 'CREATE':
      case 'DELETE':
      case 'RENAME':
      case 'APPEND':
        return no(`[CANNOT] Changing folders and saving messages from a mail app isn't available yet`)
    }

    const selected = state.selected
    if (!selected) return ['FETCH', 'SEARCH', 'STORE', 'COPY', 'MOVE', 'EXPUNGE', 'CLOSE', 'UNSELECT', 'IDLE'].includes(name) ? no('Open a folder first') : bad('Unknown command')

    switch (name) {
      case 'CLOSE':
      case 'UNSELECT':
        this.forgetFolder(state)
        return ok(`${name} done`)
      case 'IDLE':
        state.idleTag = c.tag
        await stub.watch(this.ctx.id.toString())
        await this.say(ws, '+ idling')
        // Anything that changed between the last command and now is told right away.
        return this.sync(ws, state)
      case 'STORE':
      case 'COPY':
      case 'MOVE':
      case 'EXPUNGE':
        return no("[READ-ONLY] Changes from a mail app aren't available yet")
      case 'SEARCH': {
        let criterion: Criterion
        try {
          criterion = resolveSequences(parseSearch(args), (set) => this.bySequence(set))
        } catch (err) {
          const reason = err instanceof Error ? err.message : 'Bad search'
          return reason.startsWith('[') ? no(reason) : bad(reason)
        }
        const found = await stub.imapSearch(selected.folderId, criterion)
        const numbers = byUid ? found : found.map((uid) => this.sequenceOf(uid)).filter((n) => n > 0)
        await this.say(ws, `* SEARCH${numbers.length ? ' ' + numbers.join(' ') : ''}`)
        return ok('SEARCH done')
      }
      case 'FETCH': {
        const set = parseSet(text(args[0]) ?? '')
        const items = set && this.items(args[1], byUid)
        if (!set || !items) return bad('Use FETCH <set> (<items>)')
        const since = this.changedSince(args[2])
        if (since !== null) {
          state.condstore = true
          if (!items.some((i) => i.kind === 'modseq')) items.push({ kind: 'modseq', label: 'MODSEQ' })
        }
        const wanted = byUid ? this.byUid(set) : this.bySequence(set)
        await this.fetchMessages(ws, state, auth, selected, wanted, items, since)
        return ok('FETCH done')
      }
      default:
        return bad('Unknown command')
    }
  }

  // -------------------------------------------------------------------------------------------------------------
  // Signing in

  private signInPlain(ws: WebSocket, state: State, tag: string, encoded: string) {
    // authorization-id NUL username NUL password; the first is ignored (it would be the same address).
    const parts = fromBase64(encoded)?.split('\0')
    if (!parts || parts.length !== 3) return this.say(ws, `${tag} BAD That isn't an AUTHENTICATE PLAIN answer`)
    return this.signIn(ws, state, tag, parts[1]!, parts[2]!)
  }

  private async signIn(ws: WebSocket, state: State, tag: string, address: string, password: string) {
    const signIn = await authenticateApp(this.env, address, password, state.ip || undefined)
    if (!signIn.ok) {
      if (signIn.reason === 'throttled') return this.say(ws, `${tag} NO [UNAVAILABLE] Too many sign-in attempts. Wait a minute and try again.`)
      if (signIn.reason === 'disabled') return this.say(ws, `${tag} NO [AUTHORIZATIONFAILED] Mail apps are turned off for this organization`)
      return this.say(ws, `${tag} NO [AUTHENTICATIONFAILED] Wrong address or app password`)
    }
    const { passwordId, userId, organizationId, mailboxId, address: own, canWrite } = signIn
    state.auth = { passwordId, userId, organizationId, mailboxId, address: own, canWrite }
    return this.say(ws, `${tag} OK [CAPABILITY ${CAPABILITIES}] Signed in`)
  }

  // -------------------------------------------------------------------------------------------------------------
  // Folders and the UID list

  /** The folder a mail app names: INBOX whatever its capitals, any other by its exact name. */
  private async folder(stub: Awaited<ReturnType<typeof store>>, given: string | null): Promise<ImapFolder | null> {
    if (given === null) return null
    const name = decodeName(given)
    const folders = await stub.imapFolders()
    return folders.find((f) => (f.role === 'inbox' ? name.toUpperCase() === 'INBOX' : f.name === name)) ?? null
  }

  private setUids(uids: Uint32Array) {
    this.uids = uids
    const sql = this.ctx.storage.sql
    sql.exec(`DELETE FROM kv WHERE key LIKE 'uids:%'`)
    for (let i = 0; i * UIDS_PER_ROW < uids.length; i++) {
      const piece = uids.subarray(i * UIDS_PER_ROW, (i + 1) * UIDS_PER_ROW)
      sql.exec(`INSERT INTO kv (key, value) VALUES (?, ?)`, `uids:${String(i).padStart(4, '0')}`, new Uint8Array(piece.buffer, piece.byteOffset, piece.byteLength).slice().buffer)
    }
  }

  private allUids(): Uint32Array {
    if (this.uids) return this.uids
    const rows = [...this.ctx.storage.sql.exec(`SELECT value FROM kv WHERE key LIKE 'uids:%' ORDER BY key`)] as { value: ArrayBuffer }[]
    const total = rows.reduce((n, r) => n + r.value.byteLength / 4, 0)
    const uids = new Uint32Array(total)
    let at = 0
    for (const row of rows) {
      const piece = new Uint32Array(row.value.slice(0))
      uids.set(piece, at)
      at += piece.length
    }
    this.uids = uids
    return uids
  }

  private forgetFolder(state: State) {
    state.selected = null
    this.uids = new Uint32Array(0)
    this.ctx.storage.sql.exec(`DELETE FROM kv WHERE key LIKE 'uids:%'`)
  }

  /** The message sequence number of a UID in the open folder (its place in the list), or 0 when it isn't there. */
  private sequenceOf(uid: number): number {
    const uids = this.allUids()
    let lo = 0
    let hi = uids.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (uids[mid]! === uid) return mid + 1
      if (uids[mid]! < uid) lo = mid + 1
      else hi = mid - 1
    }
    return 0
  }

  /** The UIDs a set of sequence numbers stands for, ascending. */
  private bySequence(set: [number, number][]): number[] {
    const uids = this.allUids()
    const n = uids.length
    const hit = new Set<number>()
    for (const [a, b] of set) {
      const lo = a === Infinity ? n : a
      const hi = b === Infinity ? n : Math.min(b, n)
      for (let seq = Math.max(Math.min(lo, hi), 1); seq <= hi; seq++) hit.add(uids[seq - 1]!)
    }
    return [...hit].sort((x, y) => x - y)
  }

  /** The UIDs of the open folder that a UID set names, ascending. `*` is the highest one. */
  private byUid(set: [number, number][]): number[] {
    const uids = this.allUids()
    if (!uids.length) return []
    const top = uids[uids.length - 1]!
    const out: number[] = []
    const ranges = set.map(([a, b]) => [a === Infinity ? top : Math.min(a, b === Infinity ? top : b), b === Infinity ? top : b] as const).sort((x, y) => x[0] - y[0])
    let from = 0
    for (const [lo, hi] of ranges) {
      // First UID >= lo, not before what an earlier range already took.
      let i = from
      let j = uids.length
      while (i < j) {
        const mid = (i + j) >> 1
        if (uids[mid]! < lo) i = mid + 1
        else j = mid
      }
      for (; i < uids.length && uids[i]! <= hi; i++) out.push(uids[i]!)
      from = Math.max(from, i)
    }
    return out
  }

  /**
   * Tells the mail app what changed in the open folder since it was last told: messages gone, messages new, flags
   * changed. Only called where IMAP allows it (NOOP, CHECK, IDLE), never in the middle of numbered commands.
   */
  private async sync(ws: WebSocket, state: State) {
    const { auth, selected } = state
    if (!auth || !selected) return
    const stub = await store(this.env, auth.mailboxId)
    const now = (await stub.imapFolders()).find((f) => f.id === selected.folderId)
    if (!now) return this.end(ws, '* BYE The open folder was deleted')
    if (now.total === selected.total && now.uidNext === selected.uidNext && now.highestModseq === selected.modseq) return
    const opened = await stub.imapOpen(selected.folderId)
    if (!opened) return this.end(ws, '* BYE The open folder was deleted')
    const before = this.allUids()
    const after = Uint32Array.from(opened.uids)
    const still = new Set(opened.uids)
    const lines: string[] = []
    // Highest first, so each number is still right when the mail app reads it.
    for (let seq = before.length; seq >= 1; seq--) if (!still.has(before[seq - 1]!)) lines.push(`* ${seq} EXPUNGE`)
    const gone = lines.length
    if (after.length !== before.length - gone || (after.length && before.length && after[after.length - 1]! !== before[before.length - 1]!)) lines.push(`* ${after.length} EXISTS`)
    this.setUids(after)
    if (lines.length) await this.say(ws, ...lines)
    // Flags that changed on messages the mail app already knows.
    if (opened.highestModseq > selected.modseq) {
      const known = new Set(before)
      const changed = (await stub.imapSearch(selected.folderId, { k: 'modseq', n: selected.modseq + 1 })).filter((uid) => known.has(uid))
      const items: Item[] = [{ kind: 'uid', label: 'UID' }, { kind: 'flags', label: 'FLAGS' }]
      if (state.condstore) items.push({ kind: 'modseq', label: 'MODSEQ' })
      Object.assign(selected, { total: after.length })
      await this.fetchMessages(ws, state, auth, selected, changed, items, null)
    }
    Object.assign(selected, { total: after.length, uidNext: opened.uidNext, modseq: opened.highestModseq })
  }

  // -------------------------------------------------------------------------------------------------------------
  // FETCH

  /** The data items of a FETCH: a list, one name, or a macro. null when they can't be read. */
  private items(token: Token | undefined, byUid: boolean): Item[] | null {
    if (!token) return null
    const names = token.t === 'list' ? token.items.map((i) => text(i) ?? '') : [token.v]
    const macro: Record<string, string[]> = {
      ALL: ['FLAGS', 'INTERNALDATE', 'RFC822.SIZE', 'ENVELOPE'],
      FAST: ['FLAGS', 'INTERNALDATE', 'RFC822.SIZE'],
      FULL: ['FLAGS', 'INTERNALDATE', 'RFC822.SIZE', 'ENVELOPE', 'BODY'],
    }
    const expanded = names.length === 1 ? (macro[names[0]!.toUpperCase()] ?? names) : names
    const out: Item[] = []
    for (const raw of expanded) {
      const upper = raw.toUpperCase()
      const body = /^(?:BODY(?:\.PEEK)?)\[(.*)\](?:<(\d+)\.(\d+)>)?$/i.exec(raw)
      if (body) {
        // The label echoes the section as asked, keyword in capitals, without ".PEEK" and with the start of a partial.
        const spec = body[1]!.replace(/^[^(]*/, (m) => m.toUpperCase())
        const partial: [number, number] | null = body[2] !== undefined ? [Number(body[2]), Number(body[3])] : null
        out.push({ kind: 'body', spec, partial, label: `BODY[${spec}]${partial ? `<${partial[0]}>` : ''}` })
      } else if (upper === 'UID') out.push({ kind: 'uid', label: 'UID' })
      else if (upper === 'FLAGS') out.push({ kind: 'flags', label: 'FLAGS' })
      else if (upper === 'INTERNALDATE') out.push({ kind: 'internaldate', label: 'INTERNALDATE' })
      else if (upper === 'RFC822.SIZE') out.push({ kind: 'size', label: 'RFC822.SIZE' })
      else if (upper === 'ENVELOPE') out.push({ kind: 'envelope', label: 'ENVELOPE' })
      else if (upper === 'BODY' || upper === 'BODYSTRUCTURE') out.push({ kind: 'structure', label: upper })
      else if (upper === 'MODSEQ') out.push({ kind: 'modseq', label: 'MODSEQ' })
      else if (upper === 'RFC822') out.push({ kind: 'body', spec: '', partial: null, label: 'RFC822' })
      else if (upper === 'RFC822.HEADER') out.push({ kind: 'body', spec: 'HEADER', partial: null, label: 'RFC822.HEADER' })
      else if (upper === 'RFC822.TEXT') out.push({ kind: 'body', spec: 'TEXT', partial: null, label: 'RFC822.TEXT' })
      else return null
    }
    // A UID FETCH always answers with the UID, asked for or not.
    if (byUid && !out.some((i) => i.kind === 'uid')) out.unshift({ kind: 'uid', label: 'UID' })
    return out.length ? out : null
  }

  /** `(CHANGEDSINCE n)` after the items: only messages changed after that number. */
  private changedSince(token: Token | undefined): number | null {
    if (token?.t !== 'list') return null
    const at = token.items.findIndex((i) => text(i)?.toUpperCase() === 'CHANGEDSINCE')
    const n = at < 0 ? NaN : Number(text(token.items[at + 1]))
    return Number.isFinite(n) ? n : null
  }

  private async fetchMessages(ws: WebSocket, state: State, auth: Auth, selected: Selected, wanted: number[], items: Item[], since: number | null) {
    if (!wanted.length) return
    const stub = await store(this.env, auth.mailboxId)
    const needMeta = items.some((i) => i.kind === 'envelope' || i.kind === 'structure' || i.kind === 'body')
    const step = needMeta ? ROWS_WITH_META : ROWS_PLAIN
    const out = new Output(this, ws)
    for (let at = 0; at < wanted.length; at += step) {
      const group = wanted.slice(at, at + step)
      let rows = await stub.imapRows(selected.folderId, group[0]!, group[group.length - 1]!, needMeta)
      if (rows.length !== group.length) {
        const want = new Set(group)
        rows = rows.filter((r) => want.has(r.uid))
      }
      if (since !== null) rows = rows.filter((r) => r.modseq > since)
      if (!rows.length) continue
      const metas = needMeta ? await this.metas(auth, stub, rows) : null
      // Small sections (headers, mostly) are read from R2 several at a time; anything larger one message at a time.
      const light = items.every((i) => i.kind !== 'body') || rows.every((r, n) => items.every((i) => i.kind !== 'body' || this.sectionSize(metas![n]!, i) <= SMALL_SECTION))
      const build = (row: ImapRow, n: number) => this.answer(auth, row, metas?.[n] ?? null, items, state.condstore)
      if (light) {
        for (let i = 0; i < rows.length; i += PARALLEL) {
          const answers = await Promise.all(rows.slice(i, i + PARALLEL).map((row, k) => build(row, i + k)))
          for (const pieces of answers) await out.add(pieces)
        }
      } else {
        for (let n = 0; n < rows.length; n++) {
          await out.add(await build(rows[n]!, n))
          await out.flush()
        }
      }
    }
    await out.flush()
  }

  /** What IMAP reports of each message, made now from its raw copy for the ones that don't have it yet. */
  private async metas(auth: Auth, stub: Awaited<ReturnType<typeof store>>, rows: ImapRow[]): Promise<ImapMeta[]> {
    const made: { n: number; meta: string }[] = []
    const out: ImapMeta[] = new Array(rows.length)
    const make = async (row: ImapRow, at: number) => {
      // No raw copy (a message too large to keep, or one still being copied): described as an empty message.
      let raw: Uint8Array = new Uint8Array(0)
      if (row.rawKey) {
        const res = await getObject(this.env, await this.bucketOf(auth), row.rawKey)
        if (res) raw = new Uint8Array(await res.arrayBuffer())
      }
      out[at] = describe(raw)
      if (row.rawKey && raw.length) made.push({ n: row.n, meta: JSON.stringify(out[at]) })
    }
    const missing: number[] = []
    rows.forEach((row, at) => {
      if (row.meta) out[at] = JSON.parse(row.meta) as ImapMeta
      else missing.push(at)
    })
    // Several small messages at a time; a large one alone, so only one is ever in memory.
    const small = missing.filter((at) => rows[at]!.size <= SMALL_SECTION)
    for (let i = 0; i < small.length; i += PARALLEL) await Promise.all(small.slice(i, i + PARALLEL).map((at) => make(rows[at]!, at)))
    for (const at of missing) if (rows[at]!.size > SMALL_SECTION) await make(rows[at]!, at)
    if (made.length) await stub.imapSetMeta(made)
    return out
  }

  private sectionSize(meta: ImapMeta, item: Item): number {
    if (item.kind !== 'body') return 0
    const s = section(meta, item.spec)
    if (!s) return 0
    const whole = s.end - s.start
    return item.partial ? Math.min(item.partial[1], Math.max(whole - item.partial[0], 0)) : whole
  }

  /** One message's answer: `* seq FETCH (...)`, as text and, for large sections, the bytes themselves. */
  private async answer(auth: Auth, row: ImapRow, meta: ImapMeta | null, items: Item[], condstore: boolean): Promise<(string | Uint8Array)[]> {
    const pieces: (string | Uint8Array)[] = [`* ${this.sequenceOf(row.uid)} FETCH (`]
    let firstItem = true
    const add = (label: string, value: string | Uint8Array) => {
      pieces.push(`${firstItem ? '' : ' '}${label} `)
      firstItem = false
      if (typeof value === 'string') pieces.push(value)
      else pieces.push(`{${value.length}}\r\n`, value)
    }
    for (const item of items) {
      if (item.kind === 'uid') add('UID', String(row.uid))
      else if (item.kind === 'flags') add('FLAGS', `(${flagsOf(row)})`)
      else if (item.kind === 'internaldate') add('INTERNALDATE', internalDate(row.receivedS))
      else if (item.kind === 'size') add('RFC822.SIZE', String(meta?.size ?? row.size))
      else if (item.kind === 'modseq') {
        if (condstore) add('MODSEQ', `(${row.modseq})`)
      } else if (item.kind === 'structure') add(item.label, meta!.structure)
      else if (item.kind === 'envelope') add('ENVELOPE', envelope(parseFields(await this.head(auth, row, meta!, 0, meta!.bodyStart))))
      else if (item.kind === 'body') add(item.label, await this.sectionBytes(auth, row, meta!, item))
    }
    pieces.push(')\r\n')
    return pieces
  }

  /** A header block as text: from what the store kept when it's the message's own, otherwise from R2. */
  private async head(auth: Auth, row: ImapRow, meta: ImapMeta, start: number, end: number): Promise<string> {
    if (start === 0 && end === meta.bodyStart && meta.head !== null) return meta.head
    return latin1.decode(await this.range(auth, row, start, end))
  }

  private async range(auth: Auth, row: ImapRow, start: number, end: number): Promise<Uint8Array> {
    if (!row.rawKey || end <= start) return new Uint8Array(0)
    return (await getObjectRange(this.env, await this.bucketOf(auth), row.rawKey, start, end - start)) ?? new Uint8Array(0)
  }

  /** The bytes of one BODY[...] item. A section the message doesn't have is an empty string, as IMAP has it. */
  private async sectionBytes(auth: Auth, row: ImapRow, meta: ImapMeta, item: Extract<Item, { kind: 'body' }>): Promise<Uint8Array | string> {
    const s = section(meta, item.spec)
    if (!s) return '""'
    const cut = (length: number): [number, number] => {
      if (!item.partial) return [0, length]
      const from = Math.min(item.partial[0], length)
      return [from, Math.min(from + item.partial[1], length)]
    }
    if (s.kind === 'fields') {
      const picked = toBytes(pickFields(await this.head(auth, row, meta, s.start, s.end), s.names, s.not))
      const [a, b] = cut(picked.length)
      return picked.subarray(a, b)
    }
    const [a, b] = cut(s.end - s.start)
    // The message's own header block is in the store already.
    if (s.end <= meta.bodyStart && meta.head !== null) return toBytes(meta.head.slice(s.start + a, s.start + b))
    return this.range(auth, row, s.start + a, s.start + b)
  }

  private async bucketOf(auth: Auth): Promise<string> {
    this.bucket ??= await organizationBucket(this.env, auth.organizationId)
    return this.bucket
  }

  // -------------------------------------------------------------------------------------------------------------
  // Sending

  /** Sends lines, each ended with CRLF. */
  private say(ws: WebSocket, ...lines: string[]): Promise<void> {
    return this.send(ws, toBytes(lines.map((l) => `${l}\r\n`).join('')))
  }

  /** Sends bytes in frames, never more than WINDOW ahead of what the bridge says the mail app has taken. */
  async send(ws: WebSocket, bytes: Uint8Array): Promise<void> {
    for (let at = 0; at < bytes.length; at += FRAME) {
      const waitUntil = Date.now() + STALL_MS
      while (this.sent - this.acked >= WINDOW) {
        if (Date.now() > waitUntil) {
          ws.send('close')
          throw new Closed('The mail app stopped reading')
        }
        // The timer keeps the object in memory while it waits: asleep, it would lose the answer it is half through.
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 5000)
          this.waiters.push(() => {
            clearTimeout(timer)
            resolve()
          })
        })
      }
      const frame = bytes.subarray(at, at + FRAME)
      try {
        ws.send(frame)
      } catch {
        throw new Closed('The connection is gone')
      }
      this.sent += frame.length
    }
  }

  /** Says a last line, asks the bridge to close once it's written, and stops everything that was being read. */
  private async end(ws: WebSocket, line: string): Promise<never> {
    if (line) await this.say(ws, line)
    ws.send('close')
    this.input = new Uint8Array(0)
    throw new Closed('Ended')
  }

  // -------------------------------------------------------------------------------------------------------------
  // Storage

  private saveBlob(key: string, bytes: Uint8Array) {
    this.ctx.storage.sql.exec(`INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)`, key, bytes.slice().buffer)
  }

  private loadBlob(key: string): Uint8Array {
    const row = [...this.ctx.storage.sql.exec(`SELECT value FROM kv WHERE key = ?`, key)][0] as { value: ArrayBuffer } | undefined
    return row ? new Uint8Array(row.value.slice(0)) : new Uint8Array(0)
  }

  private async forget(ws: WebSocket | undefined) {
    const state = ws?.deserializeAttachment() as State | undefined
    if (state?.auth) {
      const stub = await store(this.env, state.auth.mailboxId)
      await stub.unwatch(this.ctx.id.toString()).catch(() => undefined)
    }
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.close()
      } catch {
        // already closed
      }
    }
    await this.ctx.storage.deleteAlarm()
    await this.ctx.storage.deleteAll()
  }
}

/** Collects FETCH answers and sends them in pieces of a frame or so, so thousands of small ones aren't a frame each. */
class Output {
  private parts: Uint8Array[] = []
  private size = 0
  constructor(private session: ImapSession, private ws: WebSocket) {}

  async add(pieces: (string | Uint8Array)[]) {
    for (const piece of pieces) {
      const bytes = typeof piece === 'string' ? toBytes(piece) : piece
      this.parts.push(bytes)
      this.size += bytes.length
    }
    if (this.size >= FRAME) await this.flush()
  }

  async flush() {
    if (!this.size) return
    const all = new Uint8Array(this.size)
    let at = 0
    for (const part of this.parts) {
      all.set(part, at)
      at += part.length
    }
    this.parts = []
    this.size = 0
    await this.session.send(this.ws, all)
  }
}
