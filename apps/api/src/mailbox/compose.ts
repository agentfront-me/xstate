// Builds the MIME message a store-held mailbox sends or keeps as a draft (docs/mailbox-store-plan.md, phase 2 step
// 3). Written here rather than taken from a library so its
// output is ours to test: mime.test-style tests read every message back with our own parser. Pure: no runtime
// imports, so `pnpm test` runs it directly under Node.
//
// Shape: text/plain alone; with HTML, multipart/alternative (and multipart/related around the HTML when it shows
// inline images); with files, multipart/mixed around all of that. Text is quoted-printable when it isn't plain
// short-lined ASCII, files are base64, header words outside ASCII are RFC 2047, file names RFC 2231.

export type OutAddress = { name: string | null; email: string }

export type OutFile = {
  name: string
  type: string
  bytes: Uint8Array
  /** Content-ID, for an image the HTML shows with cid: (without angle brackets). Such files go inline. */
  cid?: string | null
}

export type OutMessage = {
  from: OutAddress
  to: OutAddress[]
  cc?: OutAddress[]
  /** Kept only in the copy the mailbox keeps (Sent, Drafts); never in what leaves (`includeBcc: false`). */
  bcc?: OutAddress[]
  replyTo?: OutAddress[]
  subject: string
  text: string
  html?: string | null
  /** Without angle brackets. */
  messageId: string
  inReplyTo?: string[]
  references?: string[]
  date: Date
  /** Extra headers, already limited to allowed names and checked for line breaks (emails/service.ts). */
  headers?: Record<string, string>
  files?: OutFile[]
  /**
   * An invitation (iTIP over email, RFC 6047): the iCalendar text goes inside the text/html alternative as
   * `text/calendar; method=…` (what Outlook and Apple Calendar read) and again as an invite.ics attachment (what Gmail
   * offers to add).
   */
  calendar?: { method: string; ics: string }
}

const enc = new TextEncoder()
const isAscii = (s: string) => /^[\x00-\x7f]*$/.test(s)

/**
 * The message as bytes, CRLF line endings. `includeBcc` only for the copy the mailbox keeps. Written straight into
 * one buffer of the exact size, file bodies as base64 without an intermediate string, so a message with 25 MB of
 * files needs about 25 MB plus the message's own size in memory.
 */
export function buildMessage(m: OutMessage, options: { includeBcc: boolean; boundary?: () => string } = { includeBcc: false }): Uint8Array {
  const boundary = options.boundary ?? randomBoundary
  const lines: string[] = []
  const header = (name: string, value: string) => lines.push(fold(`${name}: ${value}`))
  header('From', addressList([m.from]))
  if (m.to.length) header('To', addressList(m.to))
  if (m.cc?.length) header('Cc', addressList(m.cc))
  if (options.includeBcc && m.bcc?.length) header('Bcc', addressList(m.bcc))
  if (m.replyTo?.length) header('Reply-To', addressList(m.replyTo))
  header('Subject', encodeWords(m.subject))
  header('Date', rfc5322Date(m.date))
  header('Message-ID', `<${m.messageId}>`)
  if (m.inReplyTo?.length) header('In-Reply-To', m.inReplyTo.map((id) => `<${id}>`).join(' '))
  if (m.references?.length) header('References', m.references.map((id) => `<${id}>`).join(' '))
  for (const [name, value] of Object.entries(m.headers ?? {})) header(name, value)
  header('MIME-Version', '1.0')

  const files = m.files ?? []
  const inline = m.html ? files.filter((f) => f.cid) : []
  const attached = files.filter((f) => !inline.includes(f))

  const textPart = textEntity('text/plain', m.text)
  let body: Entity = textPart
  const calendarPart = m.calendar ? calendarEntity(m.calendar.method, m.calendar.ics) : null
  if (m.html || calendarPart) {
    let htmlPart = m.html ? textEntity('text/html', m.html) : null
    if (htmlPart && inline.length) htmlPart = multipart('related', [htmlPart, ...inline.map((f) => fileEntity(f, 'inline'))], boundary())
    body = multipart('alternative', [textPart, ...(htmlPart ? [htmlPart] : []), ...(calendarPart ? [calendarPart] : [])], boundary())
  }
  const invite = m.calendar ? [fileEntity({ name: 'invite.ics', type: 'application/ics', bytes: enc.encode(m.calendar.ics) }, 'attachment')] : []
  if (attached.length || invite.length) body = multipart('mixed', [body, ...attached.map((f) => fileEntity(f, 'attachment')), ...invite], boundary())

  return assemble([lines.join('\r\n') + '\r\n', ...entityChunks(body), '\r\n'])
}

/** A file's bytes, written as base64 lines when the message is assembled. */
type FileBody = { file: Uint8Array }
type Chunk = string | FileBody
type Entity = { headers: string[]; body: Chunk[] }

const entityChunks = (e: Entity): Chunk[] => [e.headers.map(fold).join('\r\n') + '\r\n\r\n', ...e.body]

function multipart(kind: string, parts: Entity[], boundary: string): Entity {
  const body: Chunk[] = []
  parts.forEach((p, i) => body.push(`${i ? '\r\n' : ''}--${boundary}\r\n`, ...entityChunks(p)))
  body.push(`\r\n--${boundary}--`)
  return { headers: [`Content-Type: multipart/${kind}; boundary="${boundary}"`], body }
}

function textEntity(type: string, text: string): Entity {
  const normalized = text.replace(/\r?\n/g, '\r\n')
  const plain = isAscii(normalized) && normalized.split('\r\n').every((l) => l.length <= 76 && !/[ \t]$/.test(l) && !l.startsWith('.'))
  return plain
    ? { headers: [`Content-Type: ${type}; charset="us-ascii"`, 'Content-Transfer-Encoding: 7bit'], body: [normalized] }
    : { headers: [`Content-Type: ${type}; charset="utf-8"`, 'Content-Transfer-Encoding: quoted-printable'], body: [quotedPrintable(normalized)] }
}

/** The invitation itself, base64 so no mail server rewraps its folded lines. */
function calendarEntity(method: string, ics: string): Entity {
  return {
    headers: [`Content-Type: text/calendar; charset="utf-8"; method=${method.replace(/[^A-Z]/gi, '')}`, 'Content-Transfer-Encoding: base64'],
    body: [{ file: enc.encode(ics) }],
  }
}

function fileEntity(f: OutFile, disposition: 'inline' | 'attachment'): Entity {
  const type = /^[\w.+-]+\/[\w.+-]+$/.test(f.type) ? f.type.toLowerCase() : 'application/octet-stream'
  const headers = [`Content-Type: ${type}; ${nameParam('name', f.name)}`, `Content-Disposition: ${disposition}; ${nameParam('filename', f.name)}`, 'Content-Transfer-Encoding: base64']
  if (f.cid) headers.push(`Content-ID: <${f.cid}>`)
  return { headers, body: [{ file: f.bytes }] }
}

/** `name="report.pdf"`, or RFC 2231 `name*=utf-8''r%C3%A9sum%C3%A9.pdf` for a name outside ASCII. */
function nameParam(param: string, name: string): string {
  const clean = name.replace(/[\r\n"\\]/g, '_')
  if (isAscii(clean)) return `${param}="${clean}"`
  const pct = [...enc.encode(clean)].map((b) => (/[A-Za-z0-9!#$&+.^_`|~-]/.test(String.fromCharCode(b)) ? String.fromCharCode(b) : `%${b.toString(16).toUpperCase().padStart(2, '0')}`)).join('')
  return `${param}*=utf-8''${pct}`
}

// ---------------------------------------------------------------------------------------------------------------
// Headers

/** A display name: as is, quoted when it has specials, or RFC 2047 when it isn't ASCII. */
function displayName(name: string): string {
  const n = name.replace(/[\r\n]/g, ' ').trim()
  if (!isAscii(n)) return encodeWords(n)
  return /^[\w !#$%&'*+\-/=?^`{|}~]*$/.test(n) ? n : `"${n.replace(/(["\\])/g, '\\$1')}"`
}

export function addressList(list: OutAddress[]): string {
  return list.map((a) => (a.name?.trim() ? `${displayName(a.name)} <${a.email}>` : a.email)).join(', ')
}

/** RFC 2047 base64 words for text outside ASCII, each at most 45 bytes of UTF-8 so a word fits a line. */
export function encodeWords(text: string): string {
  const t = text.replace(/[\r\n]+/g, ' ')
  if (isAscii(t)) return t
  const words: string[] = []
  let chunk = ''
  for (const ch of t) {
    if (enc.encode(chunk + ch).length > 45) {
      words.push(chunk)
      chunk = ''
    }
    chunk += ch
  }
  if (chunk) words.push(chunk)
  return words.map((w) => `=?UTF-8?B?${btoa(String.fromCharCode(...enc.encode(w)))}?=`).join(' ')
}

/** Folds a header line at spaces so no line passes 78 characters (where it can; RFC 5322 allows up to 998). */
function fold(line: string): string {
  if (line.length <= 78) return line
  const out: string[] = []
  let current = ''
  for (const token of line.split(/(?<= )/)) {
    if (current && (current + token).length > 78) {
      out.push(current.trimEnd())
      current = ' ' + token
    } else current += token
  }
  out.push(current)
  return out.join('\r\n')
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const two = (n: number) => String(n).padStart(2, '0')

/** "Tue, 18 Nov 2026 07:05:09 +0000". */
export function rfc5322Date(d: Date): string {
  return `${DAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())} +0000`
}

// ---------------------------------------------------------------------------------------------------------------
// Bodies

/** Quoted-printable (RFC 2045) of UTF-8 text with CRLF line breaks: lines at most 76 characters, soft breaks with "=". */
export function quotedPrintable(text: string): string {
  return text
    .split('\r\n')
    .map((line) => {
      const bytes = enc.encode(line)
      let out = ''
      let len = 0
      for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i]!
        const last = i === bytes.length - 1
        const literal = (b >= 33 && b <= 126 && b !== 61) || ((b === 32 || b === 9) && !last)
        const piece = literal ? String.fromCharCode(b) : `=${b.toString(16).toUpperCase().padStart(2, '0')}`
        if (len + piece.length > 75) {
          out += '=\r\n'
          len = 0
        }
        out += piece
        len += piece.length
      }
      return out
    })
    .join('\r\n')
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
/** Bytes per base64 line: 57 bytes make 76 characters. */
const LINE_BYTES = 57

/** Size of `bytes` as base64 lines of 76 characters joined by CRLF (no break after the last). */
function base64Size(n: number): number {
  if (!n) return 0
  const lines = Math.ceil(n / LINE_BYTES)
  return Math.ceil(n / 3) * 4 + (lines - 1) * 2
}

/** Writes `bytes` as base64 lines into `out` at `at`; returns the position after. */
function writeBase64(bytes: Uint8Array, out: Uint8Array, at: number): number {
  let o = at
  for (let i = 0; i < bytes.length; i += 3) {
    if (i && i % LINE_BYTES === 0) {
      out[o++] = 13
      out[o++] = 10
    }
    const a = bytes[i]!
    const b = i + 1 < bytes.length ? bytes[i + 1]! : 0
    const c = i + 2 < bytes.length ? bytes[i + 2]! : 0
    out[o++] = B64.charCodeAt(a >> 2)
    out[o++] = B64.charCodeAt(((a & 3) << 4) | (b >> 4))
    out[o++] = i + 1 < bytes.length ? B64.charCodeAt(((b & 15) << 2) | (c >> 6)) : 61
    out[o++] = i + 2 < bytes.length ? B64.charCodeAt(c & 63) : 61
  }
  return o
}

/** The chunks as one buffer of the exact size: strings (ASCII after encoding) and file bodies as base64. */
function assemble(chunks: Chunk[]): Uint8Array {
  const strings = chunks.map((c) => (typeof c === 'string' ? enc.encode(c) : null))
  const size = chunks.reduce((n, c, i) => n + (typeof c === 'string' ? strings[i]!.length : base64Size(c.file.length)), 0)
  const out = new Uint8Array(size)
  let at = 0
  chunks.forEach((c, i) => {
    if (typeof c === 'string') {
      out.set(strings[i]!, at)
      at += strings[i]!.length
    } else at = writeBase64(c.file, out, at)
  })
  return out
}

function randomBoundary(): string {
  return `=_xstate_${[...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, '0')).join('')}`
}
