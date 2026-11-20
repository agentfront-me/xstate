// One mail-app connection (docs/imap-smtp-relay-plan.md, 3.3). The mail bridge hands the connection over as a
// WebSocket: binary frames are the connection's bytes, text frames are control ("ack <n>" from the bridge, "close"
// to it; see services/mail-bridge/main.go).
//
// PHASE 0 SPIKE. This speaks just enough IMAP to prove the parts the plan depends on, and no mailbox is behind it:
//   - the socket hibernates, so an idle connection costs nothing, and the session survives memory being reset;
//   - session state lives in the socket's attachment (small) and this object's SQLite storage (the UID list);
//   - a large download is sent with flow control, at most WINDOW bytes ahead of what the mail app has taken;
//   - something outside can wake an idling session (changed(), as the mailbox store will);
//   - storage is deleted when the connection closes, or by an alarm if the bridge dies without closing.
// Phase 3 replaces the command handling with real IMAP against the mailbox store. Sign-in here is one test login,
// RELAY_SPIKE_LOGIN ("user:password"); without it every LOGIN is refused.

import { DurableObject } from 'cloudflare:workers'

const FRAME = 64 * 1024
/** Most bytes sent ahead of the bridge's last ack. The bridge acks every 256 KB, so this can't stall. */
const WINDOW = 1024 * 1024
const DAY_MS = 24 * 60 * 60 * 1000
/** A partial command line longer than this is not IMAP we speak: the connection is closed. */
const MAX_LINE = 8 * 1024
const SPIKE_MESSAGES = 5000

/** What survives hibernation with the socket (at most 16 KB): everything about the session except the UID list. */
type State = {
  ip: string
  user: string | null
  folder: string | null
  /** The tag of the IDLE command the session is in, or null. */
  idleTag: string | null
  /** Bytes sent to the bridge, and how many of them it says the mail app has taken. */
  sent: number
  acked: number
  /** A download in progress: bytes left to send and the tag to answer when it's done. */
  blobLeft: number
  blobTag: string | null
  /** The start of a command line whose end hasn't arrived yet. */
  partial: string
  /** Commands handled, counted here so it survives hibernation (compare with `this.inMemory`). */
  commands: number
}

type SpikeEnv = { RELAY_SPIKE_LOGIN?: string }

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export class ImapSession extends DurableObject<Env> {
  /** Commands handled since this object was last loaded into memory. Lower than `commands` after a hibernation. */
  private inMemory = 0

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS uids (seq INTEGER PRIMARY KEY, uid INTEGER NOT NULL)`)
  }

  /** A new connection from the bridge, already checked by relay/route.ts. */
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 })
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket]
    this.ctx.acceptWebSocket(server)
    const state: State = {
      ip: new URL(request.url).searchParams.get('ip') ?? '',
      user: null, folder: null, idleTag: null, sent: 0, acked: 0, blobLeft: 0, blobTag: null, partial: '', commands: 0,
    }
    this.write(server, state, '* OK [CAPABILITY IMAP4rev1 IDLE] xstate ready\r\n')
    server.serializeAttachment(state)
    await this.ctx.storage.setAlarm(Date.now() + DAY_MS)
    return new Response(null, { status: 101, webSocket: client })
  }

  override async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string) {
    const state = ws.deserializeAttachment() as State
    if (typeof message === 'string') {
      const acked = /^ack (\d+)$/.exec(message)
      if (acked) {
        state.acked = Math.max(state.acked, Number(acked[1]))
        this.continueBlob(ws, state)
      }
    } else {
      const text = state.partial + decoder.decode(message)
      const lines = text.split('\r\n')
      state.partial = lines.pop() ?? ''
      if (state.partial.length > MAX_LINE) {
        this.end(ws, state, '* BYE Line too long\r\n')
        return
      }
      for (const line of lines) {
        if (this.command(ws, state, line) === 'end') return
      }
    }
    ws.serializeAttachment(state)
  }

  override async webSocketClose() {
    await this.forget()
  }

  override async webSocketError() {
    await this.forget()
  }

  /** Daily: a session whose bridge vanished without closing is cleaned up; a live one is checked again tomorrow. */
  override async alarm() {
    if (this.ctx.getWebSockets().length) await this.ctx.storage.setAlarm(Date.now() + DAY_MS)
    else await this.forget()
  }

  /** Called from outside (later: by the mailbox store) when the mailbox changed. True when the session was told. */
  async changed(): Promise<boolean> {
    const ws = this.ctx.getWebSockets()[0]
    if (!ws) return false
    const state = ws.deserializeAttachment() as State
    if (!state.idleTag) return false
    const count = this.count() + 1
    this.ctx.storage.sql.exec(`INSERT INTO uids (seq, uid) VALUES (?, ?)`, count, count * 3)
    this.write(ws, state, `* ${count} EXISTS\r\n`)
    ws.serializeAttachment(state)
    return true
  }

  /** Spike only: the session's counters, to watch flow control from outside while a download is held up. */
  async peek(): Promise<{ sent: number; acked: number; blobLeft: number; inMemory: number } | null> {
    const ws = this.ctx.getWebSockets()[0]
    if (!ws) return null
    const { sent, acked, blobLeft } = ws.deserializeAttachment() as State
    return { sent, acked, blobLeft, inMemory: this.inMemory }
  }

  private command(ws: WebSocket, state: State, line: string): 'end' | void {
    state.commands++
    this.inMemory++
    if (state.idleTag) {
      if (line.toUpperCase() === 'DONE') {
        this.write(ws, state, `${state.idleTag} OK IDLE done\r\n`)
        state.idleTag = null
      }
      return
    }
    const [tag = '*', verb = '', ...args] = line.split(' ')
    const ok = (text: string) => this.write(ws, state, `${tag} OK ${text}\r\n`)
    const no = (text: string) => this.write(ws, state, `${tag} NO ${text}\r\n`)
    switch (verb.toUpperCase()) {
      case 'CAPABILITY':
        this.write(ws, state, '* CAPABILITY IMAP4rev1 IDLE\r\n')
        return ok('CAPABILITY done')
      case 'NOOP':
        return ok('NOOP done')
      case 'LOGIN': {
        const [user, password] = args.map((a) => a.replace(/^"(.*)"$/, '$1'))
        const allowed = (this.env as SpikeEnv).RELAY_SPIKE_LOGIN
        if (!allowed || `${user}:${password}` !== allowed) return no('[AUTHENTICATIONFAILED] Wrong address or password')
        state.user = user ?? null
        return ok('LOGIN done')
      }
      case 'SELECT': {
        if (!state.user) return no('Log in first')
        // The UID list goes into storage, not memory: it must still be here after the object hibernates.
        this.ctx.storage.sql.exec(`DELETE FROM uids`)
        for (let seq = 1; seq <= SPIKE_MESSAGES; seq++) this.ctx.storage.sql.exec(`INSERT INTO uids (seq, uid) VALUES (?, ?)`, seq, seq * 3)
        state.folder = 'INBOX'
        this.write(ws, state, `* ${SPIKE_MESSAGES} EXISTS\r\n* 0 RECENT\r\n* OK [UIDVALIDITY 1] UIDs valid\r\n* OK [UIDNEXT ${SPIKE_MESSAGES * 3 + 1}] Next UID\r\n* FLAGS (\\Seen)\r\n* OK [PERMANENTFLAGS ()] Read-only\r\n`)
        return ok('[READ-ONLY] SELECT done')
      }
      case 'IDLE':
        if (!state.folder) return no('Select a folder first')
        state.idleTag = tag
        return this.write(ws, state, '+ idling\r\n')
      case 'XSTATE': {
        // Spike only: shows whether memory was reset (in-memory lower than stored) while storage and the socket stayed.
        const last = [...this.ctx.storage.sql.exec(`SELECT uid FROM uids ORDER BY seq DESC LIMIT 1`)][0] as { uid: number } | undefined
        this.write(ws, state, `* XSTATE id=${this.ctx.id.toString()} commands=${state.commands} in-memory=${this.inMemory} uids=${this.count()} last-uid=${last?.uid ?? 0} sent=${state.sent} acked=${state.acked} ip=${state.ip}\r\n`)
        return ok('XSTATE done')
      }
      case 'XBLOB': {
        // Spike only: a download of args[0] bytes, as a FETCH of a large message will be.
        const size = Math.min(Math.max(Number(args[0]) || 0, 0), 64 * 1024 * 1024)
        if (!state.user) return no('Log in first')
        this.write(ws, state, `* XBLOB {${size}}\r\n`)
        state.blobLeft = size
        state.blobTag = tag
        return this.continueBlob(ws, state)
      }
      case 'LOGOUT':
        this.write(ws, state, '* BYE Logging out\r\n')
        ok('LOGOUT done')
        return this.end(ws, state, '')
      default:
        return this.write(ws, state, `${tag} BAD Unknown command\r\n`)
    }
  }

  /** Sends as much of the download as the window allows; the bridge's next ack brings it back here. */
  private continueBlob(ws: WebSocket, state: State) {
    if (!state.blobTag) return
    while (state.blobLeft > 0 && state.sent - state.acked < WINDOW) {
      const size = Math.min(FRAME, state.blobLeft)
      ws.send(new Uint8Array(size).fill(120)) // 'x'
      state.sent += size
      state.blobLeft -= size
    }
    if (state.blobLeft === 0) {
      this.write(ws, state, `\r\n${state.blobTag} OK XBLOB done\r\n`)
      state.blobTag = null
    }
  }

  private write(ws: WebSocket, state: State, text: string) {
    const bytes = encoder.encode(text)
    ws.send(bytes)
    state.sent += bytes.length
  }

  /** Says a last line, asks the bridge to close once it's written, and forgets the session. */
  private end(ws: WebSocket, state: State, text: string): 'end' {
    if (text) this.write(ws, state, text)
    ws.send('close')
    ws.serializeAttachment(state)
    return 'end'
  }

  private count(): number {
    return ([...this.ctx.storage.sql.exec(`SELECT COUNT(*) AS c FROM uids`)][0] as { c: number }).c
  }

  private async forget() {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close()
      } catch {
        // already closed
      }
    }
    await this.ctx.storage.deleteAlarm()
    await this.ctx.storage.deleteAll()
  }
}
