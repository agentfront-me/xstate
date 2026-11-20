// One mail app's sending connection (docs/imap-smtp-relay-plan.md §5): SMTP submission, spoken to the mail bridge
// over a WebSocket (binary frames are the connection's bytes; see services/mail-bridge/main.go). The app signs in
// with a mailbox address and an app password, and the message it hands over is sent by mailbox/outbound-raw.ts, so
// it passes every check and limit a message written in the web app does, and gets its Sent copy.
//
// "250 OK" is the answer only once SES has taken the message: nothing waits in a queue here.
//
// State. The few facts about the session ride in the socket's attachment and the recipients in storage, so they
// survive hibernation between commands. The message itself is collected in memory while it arrives; if the object
// is reset in the middle of one (the app went silent for a long while mid-message), the app is told to send again.

import { DurableObject } from 'cloudflare:workers'
import { authenticateApp } from '../auth/app-passwords'
import * as mailboxesDb from '../db/mailboxes'
import { ApiError } from '../errors'
import { MAX_RECIPIENTS } from '../mailserver/messages'
import { MAX_RAW_BYTES, sendRawFromStore } from '../mailbox/outbound-raw'

const HOST = 'mail.xstate.com'
const MAX_LINE = 4096
const DAY_MS = 24 * 60 * 60 * 1000
/** Failed sign-ins on one connection before it is closed. */
const MAX_AUTH_TRIES = 3

type State = {
  ip: string
  /** Set once signed in. `addresses` are the ones the mailbox may send from; `canWrite` false is read-only access. */
  mailboxId: string | null
  address: string | null
  addresses: string[]
  canWrite: boolean
  authTries: number
  /** A sign-in in progress: which answer is awaited, and the username already given (AUTH LOGIN). */
  auth: { step: 'plain' | 'user' | 'password'; user?: string } | null
  mailFrom: string | null
  /** command: reading commands. data: collecting a message. discard: reading an oversized message to its end. */
  phase: 'command' | 'data' | 'discard'
  /** The start of a command line whose end hasn't arrived yet. */
  partial: string
  messages: number
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const fromBase64 = (text: string): string | null => {
  try {
    return decoder.decode(Uint8Array.from(atob(text.trim()), (c) => c.charCodeAt(0)))
  } catch {
    return null
  }
}
/** The address in `MAIL FROM:<a@b> SIZE=1` or `RCPT TO:<a@b>`, and the parameters after it. */
const path = (rest: string) => /^:\s*<([^>]*)>\s*(.*)$/.exec(rest)

export class SmtpSession extends DurableObject<Env> {
  /** The message being received, in the order it arrived. Memory only: see the note on state above. */
  private chunks: Uint8Array[] | null = null
  private bytes = 0
  /** The last bytes seen, to find the end marker (CRLF . CRLF) when it is split across frames. */
  private tail: Uint8Array = new Uint8Array(0)

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS recipients (address TEXT PRIMARY KEY)`)
  }

  /** A new connection from the bridge, already checked by relay/route.ts. */
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 })
    const url = new URL(request.url)
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket]
    this.ctx.acceptWebSocket(server)
    const state: State = {
      ip: url.searchParams.get('ip') ?? '',
      mailboxId: null, address: null, addresses: [], canWrite: false, authTries: 0, auth: null, mailFrom: null, phase: 'command', partial: '', messages: 0,
    }
    // On port 587 the bridge has already greeted the app and done STARTTLS; on 465 the greeting is ours.
    if (url.searchParams.get('tls') !== 'starttls') this.say(server, `220 ${HOST} ESMTP xstate`)
    server.serializeAttachment(state)
    await this.ctx.storage.setAlarm(Date.now() + DAY_MS)
    return new Response(null, { status: 101, webSocket: client })
  }

  override async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string) {
    if (typeof message === 'string') return // "ack <n>": replies here are a few lines, so there is nothing to pace.
    const state = ws.deserializeAttachment() as State
    let bytes: Uint8Array = new Uint8Array(message)
    // The object was reset while a message was arriving: what came before is gone.
    if (state.phase !== 'command' && !this.chunks) return void this.end(ws, '421 4.3.0 The connection was idle for too long. Send the message again.')
    while (bytes.length) {
      if (state.phase !== 'command') {
        const rest = await this.data(ws, state, bytes)
        if (!rest) break
        bytes = rest
        continue
      }
      // One line at a time, found in the bytes themselves: what follows a command may be a message, not text.
      const at = bytes.indexOf(10)
      if (at < 0) {
        state.partial += decoder.decode(bytes)
        if (state.partial.length > MAX_LINE) return void this.end(ws, '500 5.5.2 Line too long')
        break
      }
      const line = (state.partial + decoder.decode(bytes.subarray(0, at))).replace(/\r$/, '')
      state.partial = ''
      bytes = bytes.subarray(at + 1)
      if (line.length > MAX_LINE) return void this.end(ws, '500 5.5.2 Line too long')
      if ((await this.command(ws, state, line)) === 'end') return
    }
    ws.serializeAttachment(state)
  }

  override async webSocketClose() {
    await this.forget()
  }

  override async webSocketError() {
    await this.forget()
  }

  override async alarm() {
    await this.forget()
  }

  private async command(ws: WebSocket, state: State, line: string): Promise<'end' | void> {
    if (state.auth) return this.authAnswer(ws, state, line)
    const space = line.search(/[ :]/)
    const verb = (space < 0 ? line : line.slice(0, space)).toUpperCase()
    const rest = space < 0 ? '' : line.slice(space).trim()
    switch (verb) {
      case 'EHLO':
        this.reset(state)
        return this.say(ws, `250-${HOST}`, `250-SIZE ${MAX_RAW_BYTES}`, '250-8BITMIME', '250-PIPELINING', '250-ENHANCEDSTATUSCODES', '250 AUTH PLAIN LOGIN')
      case 'HELO':
        this.reset(state)
        return this.say(ws, `250 ${HOST}`)
      case 'NOOP':
        return this.say(ws, '250 2.0.0 OK')
      case 'RSET':
        this.reset(state)
        return this.say(ws, '250 2.0.0 OK')
      case 'QUIT':
        return this.end(ws, '221 2.0.0 Bye')
      case 'STARTTLS':
        return this.say(ws, '503 5.5.1 The connection is already encrypted')
      case 'VRFY':
        return this.say(ws, '252 2.1.5 Send some mail and find out')
      case 'AUTH': {
        if (state.mailboxId) return this.say(ws, '503 5.5.1 Already signed in')
        const [mechanism = '', initial] = rest.split(/\s+/)
        if (mechanism.toUpperCase() === 'PLAIN') {
          if (initial && initial !== '=') return this.signInPlain(ws, state, initial)
          state.auth = { step: 'plain' }
          return this.say(ws, '334 ')
        }
        if (mechanism.toUpperCase() === 'LOGIN') {
          const user = initial ? fromBase64(initial) : null
          state.auth = user ? { step: 'password', user } : { step: 'user' }
          return this.say(ws, user ? '334 UGFzc3dvcmQ6' : '334 VXNlcm5hbWU6')
        }
        return this.say(ws, '504 5.5.4 Use AUTH PLAIN or AUTH LOGIN')
      }
      case 'MAIL': {
        const m = /^FROM/i.test(rest) ? path(rest.slice(4)) : null
        if (!m) return this.say(ws, '501 5.5.4 Use MAIL FROM:<address>')
        if (!state.mailboxId) return this.say(ws, '530 5.7.0 Sign in first')
        if (!state.canWrite) return this.say(ws, '550 5.7.1 You can only read this mailbox, so you can’t send from it')
        if (state.mailFrom !== null) return this.say(ws, '503 5.5.1 MAIL was already given; send RSET to start again')
        const from = m[1]!.trim().toLowerCase()
        if (!state.addresses.includes(from)) return this.say(ws, `550 5.7.1 This mailbox may not send from that address. Use ${state.address}.`)
        const declared = /\bSIZE=(\d+)/i.exec(m[2] ?? '')
        if (declared && Number(declared[1]) > MAX_RAW_BYTES) return this.say(ws, this.tooLarge())
        state.mailFrom = from
        return this.say(ws, '250 2.1.0 OK')
      }
      case 'RCPT': {
        const m = /^TO/i.test(rest) ? path(rest.slice(2)) : null
        if (!m) return this.say(ws, '501 5.5.4 Use RCPT TO:<address>')
        if (state.mailFrom === null) return this.say(ws, '503 5.5.1 Send MAIL FROM first')
        const to = m[1]!.trim().toLowerCase()
        if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(to) || to.length > 320) return this.say(ws, '553 5.1.3 That isn’t an email address')
        if (this.recipients().length >= MAX_RECIPIENTS && !this.recipients().includes(to)) {
          return this.say(ws, `452 4.5.3 A message can have at most ${MAX_RECIPIENTS} recipients`)
        }
        this.ctx.storage.sql.exec(`INSERT OR IGNORE INTO recipients (address) VALUES (?)`, to)
        return this.say(ws, '250 2.1.5 OK')
      }
      case 'DATA':
        if (state.mailFrom === null) return this.say(ws, '503 5.5.1 Send MAIL FROM first')
        if (!this.recipients().length) return this.say(ws, '554 5.5.1 No recipients')
        state.phase = 'data'
        this.chunks = []
        this.bytes = 0
        // As if a line break came first, so a message that is only "." ends it.
        this.tail = encoder.encode('\r\n')
        return this.say(ws, '354 End the message with a line holding only a dot')
      default:
        return this.say(ws, '500 5.5.2 Unknown command')
    }
  }

  // -------------------------------------------------------------------------------------------------------------
  // Signing in

  private authAnswer(ws: WebSocket, state: State, line: string): Promise<'end' | void> | 'end' | void {
    const auth = state.auth!
    state.auth = null
    if (line === '*') return this.say(ws, '501 5.7.0 Sign-in cancelled')
    if (auth.step === 'plain') return this.signInPlain(ws, state, line)
    const value = fromBase64(line)
    if (value === null) return this.say(ws, '501 5.5.2 That isn’t base64')
    if (auth.step === 'user') {
      state.auth = { step: 'password', user: value }
      return this.say(ws, '334 UGFzc3dvcmQ6')
    }
    return this.signIn(ws, state, auth.user ?? '', value)
  }

  private signInPlain(ws: WebSocket, state: State, encoded: string) {
    // authorization-id NUL username NUL password; the first is ignored (it would be the same address).
    const parts = fromBase64(encoded)?.split('\0')
    if (!parts || parts.length !== 3) return this.say(ws, '501 5.5.2 That isn’t an AUTH PLAIN answer')
    return this.signIn(ws, state, parts[1]!, parts[2]!)
  }

  private async signIn(ws: WebSocket, state: State, address: string, password: string): Promise<'end' | void> {
    const signIn = await authenticateApp(this.env, address, password, state.ip || undefined)
    if (!signIn.ok) {
      if (signIn.reason === 'throttled') return this.say(ws, '454 4.7.0 Too many sign-in attempts. Wait a minute and try again.')
      if (++state.authTries >= MAX_AUTH_TRIES) return this.end(ws, '535 5.7.8 Wrong address or app password')
      if (signIn.reason === 'disabled') return this.say(ws, '535 5.7.8 Mail apps are turned off for this organization')
      return this.say(ws, '535 5.7.8 Wrong address or app password')
    }
    const mailbox = await mailboxesDb.find(this.env.DB, signIn.mailboxId)
    if (!mailbox) return this.say(ws, '535 5.7.8 Wrong address or app password')
    state.mailboxId = mailbox.id
    state.address = mailbox.address
    state.addresses = [mailbox.address, ...(JSON.parse(mailbox.aliases || '[]') as string[])].map((a) => a.toLowerCase())
    state.canWrite = signIn.canWrite
    return this.say(ws, '235 2.7.0 Signed in')
  }

  // -------------------------------------------------------------------------------------------------------------
  // The message

  /**
   * Takes more of the message. Returns the bytes after its end (the next commands, when the app sends them ahead),
   * or null when the end hasn't come yet.
   */
  private async data(ws: WebSocket, state: State, bytes: Uint8Array): Promise<Uint8Array | null> {
    // Look for CRLF . CRLF in the last 4 bytes seen plus the new ones.
    const joined = new Uint8Array(this.tail.length + bytes.length)
    joined.set(this.tail)
    joined.set(bytes, this.tail.length)
    let end = -1
    for (let i = 0; i + 4 < joined.length; i++) {
      if (joined[i] === 13 && joined[i + 1] === 10 && joined[i + 2] === 46 && joined[i + 3] === 13 && joined[i + 4] === 10) {
        end = i
        break
      }
    }
    if (end < 0) {
      this.keep(state, bytes)
      this.tail = joined.slice(Math.max(joined.length - 4, 0))
      return null
    }
    // `end` is where the marker starts in `joined`; the message keeps the line break before the dot.
    const upTo = end + 2 - this.tail.length
    if (upTo > 0) this.keep(state, bytes.subarray(0, upTo))
    else if (upTo < 0) this.bytes += upTo // the marker began in bytes already kept: drop its start again below
    const rest = bytes.subarray(end + 5 - this.tail.length)

    const tooBig = state.phase === 'discard'
    let raw: Uint8Array | null = tooBig ? null : this.assemble(upTo < 0 ? -upTo : 0)
    this.chunks = null
    this.tail = new Uint8Array(0)
    state.phase = 'command'
    const recipients = this.recipients()
    const mailboxId = state.mailboxId!
    this.reset(state)
    if (!raw) this.say(ws, this.tooLarge())
    else {
      try {
        const mailbox = await mailboxesDb.find(this.env.DB, mailboxId)
        if (!mailbox) throw new ApiError('mailbox_not_found', 'This mailbox no longer exists', 404)
        const send = { raw, recipients }
        raw = null
        const sent = await sendRawFromStore(this.env, mailbox, send)
        state.messages++
        this.say(ws, `250 2.0.0 OK: sent as ${sent.sesId}`)
      } catch (err) {
        this.say(ws, this.refusal(err))
      }
    }
    return rest
  }

  private keep(state: State, bytes: Uint8Array) {
    this.bytes += bytes.length
    // Far past the limit already (dots removed later only shrink it a little): stop keeping, read on to the end.
    if (this.bytes > MAX_RAW_BYTES + 1024 * 1024) {
      state.phase = 'discard'
      this.chunks = []
    } else if (state.phase === 'data') this.chunks!.push(bytes.slice())
  }

  /** The message as one buffer, with SMTP's dot-stuffing undone (a line starting with a dot lost one on the way). */
  private assemble(dropFromEnd: number): Uint8Array | null {
    const total = this.chunks!.reduce((n, c) => n + c.length, 0) - dropFromEnd
    const raw = new Uint8Array(Math.max(total, 0))
    let at = 0
    for (const chunk of this.chunks!) {
      const part = chunk.subarray(0, Math.min(chunk.length, raw.length - at))
      raw.set(part, at)
      at += part.length
    }
    this.chunks = []
    let w = 0
    let lineStart = true
    for (let r = 0; r < raw.length; r++) {
      const b = raw[r]!
      if (lineStart && b === 46) {
        lineStart = false
        continue
      }
      lineStart = b === 10
      raw[w++] = b
    }
    return w > MAX_RAW_BYTES ? null : raw.subarray(0, w)
  }

  /** The SMTP answer for a refused message: what a person can act on, with the code that tells the app to retry or not. */
  private refusal(err: unknown): string {
    if (!(err instanceof ApiError)) {
      console.error('smtp: send failed', err)
      return '451 4.3.0 The message couldn’t be sent right now. Try again in a few minutes.'
    }
    const text = err.message.replace(/[\r\n]+/g, ' ')
    if (err.code === 'message_too_large' || err.code === 'attachments_too_large') return `552 5.3.4 ${text}`
    if (err.code === 'too_many_recipients') return `452 4.5.3 ${text}`
    if (err.status === 429) return `451 4.7.1 ${text}`
    if (err.status >= 500) return `451 4.3.0 ${text}`
    return `550 5.7.1 ${text}`
  }

  private tooLarge() {
    return `552 5.3.4 A message can be at most ${MAX_RAW_BYTES / 1024 / 1024} MB, and its attachments 25 MB. Share large files from Storage as a link.`
  }

  // -------------------------------------------------------------------------------------------------------------

  private recipients(): string[] {
    return ([...this.ctx.storage.sql.exec(`SELECT address FROM recipients ORDER BY rowid`)] as { address: string }[]).map((r) => r.address)
  }

  /** Forgets the message being addressed (after it is sent, on RSET and on EHLO). The sign-in stays. */
  private reset(state: State) {
    state.mailFrom = null
    this.ctx.storage.sql.exec(`DELETE FROM recipients`)
  }

  private say(ws: WebSocket, ...lines: string[]) {
    ws.send(encoder.encode(lines.map((l) => `${l}\r\n`).join('')))
  }

  /** Says a last line and asks the bridge to close once it's written. */
  private end(ws: WebSocket, line: string): 'end' {
    this.say(ws, line)
    ws.send('close')
    return 'end'
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
