// A raw message as IMAP describes it (RFC 3501 §7.4.2): its ENVELOPE, its BODYSTRUCTURE, and where each numbered
// section sits in the bytes. Worked out once per message and kept in the mailbox store (`imap_meta`), so a mail
// app's first sync reads rows, not messages. Pure: no runtime imports, so the tests run under Node.
//
// Text here is latin1: one character per byte, so lengths are byte lengths and nothing is re-encoded on the way out.

/** Where something starts, where its body starts (after its headers' blank line), and where it ends. */
export type Range = [start: number, bodyStart: number, end: number]

export type ImapMeta = {
  v: 1
  size: number
  bodyStart: number
  /** The whole header block with its blank line, or null when it is too long to keep (then it is read from R2). */
  head: string | null
  /** BODYSTRUCTURE, ready to send. */
  structure: string
  /** Each part by its section number ("1", "2.1"): its own headers, its body, its end. */
  parts: Record<string, Range>
  /** For each message/rfc822 part: the message inside it. */
  messages: Record<string, Range>
}

/** Header blocks longer than this aren't kept in the store. */
export const MAX_HEAD = 32 * 1024
const MAX_DEPTH = 20

const latin1 = new TextDecoder('latin1')
const CR = 13
const LF = 10

export type Header = { name: string; value: string; raw: string }

/** The header block from `from`: its fields, and where the body starts (just past the blank line). */
export function readHeaders(buf: Uint8Array, from: number, to: number): { fields: Header[]; bodyStart: number } {
  let bodyStart = to
  let end = to
  for (let i = from; i < to; i++) {
    if (buf[i] !== LF) continue
    // A blank line: LF LF, LF CR LF, or a message that starts with one.
    const next = buf[i + 1] === CR && buf[i + 2] === LF ? i + 3 : buf[i + 1] === LF ? i + 2 : -1
    if (next > 0 && next <= to) {
      end = i + 1
      bodyStart = next
      break
    }
  }
  if (buf[from] === LF || (buf[from] === CR && buf[from + 1] === LF)) {
    end = from
    bodyStart = from + (buf[from] === LF ? 1 : 2)
  }
  return { fields: parseFields(latin1.decode(buf.subarray(from, end))), bodyStart }
}

export function parseFields(head: string): Header[] {
  const out: Header[] = []
  for (const line of head.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const last = out[out.length - 1]
    if (last && /^[ \t]/.test(line)) last.raw += line
    else if (line.includes(':')) out.push({ name: line.slice(0, line.indexOf(':')).trim().toLowerCase(), value: '', raw: line })
  }
  for (const f of out) f.value = f.raw.slice(f.raw.indexOf(':') + 1).replace(/\r?\n(?=[ \t])/g, '').trim()
  return out
}

const first = (fields: Header[], name: string) => fields.find((f) => f.name === name)?.value ?? null

// ---------------------------------------------------------------------------------------------------------------
// Writing IMAP data

/** A string as IMAP writes it: quoted when it can be, otherwise a literal. */
export function quote(s: string): string {
  if (/[\r\n\0]/.test(s) || /[\x80-\xff]/.test(s) || s.length > 1000) return `{${s.length}}\r\n${s}`
  return `"${s.replace(/[\\"]/g, '\\$&')}"`
}
export const nstring = (s: string | null | undefined) => (s === null || s === undefined ? 'NIL' : quote(s))

// ---------------------------------------------------------------------------------------------------------------
// ENVELOPE

type Address = { name: string | null; mailbox: string | null; host: string | null }

/** Splits at `separator` where it isn't inside quotes, a comment or angle brackets. */
function split(value: string, separator: string): string[] {
  const out: string[] = []
  let depth = 0
  let quoted = false
  let angle = false
  let start = 0
  for (let i = 0; i < value.length; i++) {
    const c = value[i]
    if (c === '\\') i++
    else if (quoted) quoted = c !== '"'
    else if (c === '"') quoted = true
    else if (c === '(') depth++
    else if (c === ')') depth = Math.max(depth - 1, 0)
    else if (depth) continue
    else if (c === '<') angle = true
    else if (c === '>') angle = false
    else if (c === separator && !angle) {
      out.push(value.slice(start, i))
      start = i + 1
    }
  }
  out.push(value.slice(start))
  return out
}

const unquote = (s: string) => (/^".*"$/s.test(s) ? s.slice(1, -1).replace(/\\(.)/g, '$1') : s)
const comments = (s: string) => [...s.matchAll(/\(([^()]*)\)/g)].map((m) => m[1]!.trim())
const withoutComments = (s: string) => s.replace(/\([^()]*\)/g, ' ').trim()

function mailbox(text: string): Address | null {
  const angle = /<([^>]*)>/.exec(text)
  let name: string | null
  let spec: string
  if (angle) {
    name = unquote(withoutComments(text.slice(0, angle.index)).trim()) || null
    spec = angle[1]!.replace(/^[^:]*:/, '').trim() // drop an old-style route (@a,@b:)
  } else {
    name = comments(text)[0] || null
    spec = withoutComments(text)
  }
  if (!spec) return null
  const at = spec.lastIndexOf('@')
  return { name, mailbox: unquote(at < 0 ? spec : spec.slice(0, at)), host: at < 0 ? null : spec.slice(at + 1) }
}

/** An address header's value as ENVELOPE lists it. A group is bracketed by its name and an empty entry. */
export function addresses(value: string | null): Address[] {
  if (!value) return []
  const out: Address[] = []
  for (const piece of split(value, ',')) {
    const group = split(piece, ':')
    // "name: a, b;" (not the colon of a route inside angle brackets, which split() skips).
    if (group.length > 1 && !/^\s*</.test(piece)) {
      out.push({ name: null, mailbox: unquote(group[0]!.trim()), host: null })
      const rest = group.slice(1).join(':')
      const member = mailbox(rest.replace(/;\s*$/, ''))
      if (member) out.push(member)
      if (/;\s*$/.test(rest)) out.push({ name: null, mailbox: null, host: null })
      continue
    }
    const closes = /;\s*$/.test(piece)
    const one = mailbox(closes ? piece.replace(/;\s*$/, '') : piece)
    if (one) out.push(one)
    if (closes) out.push({ name: null, mailbox: null, host: null })
  }
  return out
}

const addressList = (list: Address[]) =>
  list.length ? `(${list.map((a) => `(${nstring(a.name)} NIL ${nstring(a.mailbox)} ${nstring(a.host)})`).join('')})` : 'NIL'

/** ENVELOPE: date, subject, from, sender, reply-to, to, cc, bcc, in-reply-to, message-id. */
export function envelope(fields: Header[]): string {
  const from = addresses(first(fields, 'from'))
  const or = (name: string) => {
    const own = addresses(first(fields, name))
    return own.length ? own : from
  }
  return `(${[
    nstring(first(fields, 'date')),
    nstring(first(fields, 'subject')),
    addressList(from),
    addressList(or('sender')),
    addressList(or('reply-to')),
    addressList(addresses(first(fields, 'to'))),
    addressList(addresses(first(fields, 'cc'))),
    addressList(addresses(first(fields, 'bcc'))),
    nstring(first(fields, 'in-reply-to')),
    nstring(first(fields, 'message-id')),
  ].join(' ')})`
}

// ---------------------------------------------------------------------------------------------------------------
// BODYSTRUCTURE and the section map

/** `type/subtype; a=b; c="d"` as its type and parameters. */
function typed(value: string | null, fallback: string): { type: string; subtype: string; params: [string, string][] } {
  const [kind = '', ...rest] = split(value ?? fallback, ';')
  const [type = '', subtype = ''] = kind.trim().toLowerCase().split('/')
  const params: [string, string][] = []
  for (const p of rest) {
    const eq = p.indexOf('=')
    if (eq > 0) params.push([p.slice(0, eq).trim().toLowerCase(), unquote(p.slice(eq + 1).trim())])
  }
  return type && subtype ? { type, subtype, params } : typed(null, fallback === value ? 'text/plain' : fallback)
}

const paramList = (params: [string, string][]) => (params.length ? `(${params.map(([k, v]) => `${quote(k)} ${quote(v)}`).join(' ')})` : 'NIL')

function dispositionOf(fields: Header[]): string {
  const value = first(fields, 'content-disposition')
  if (!value) return 'NIL'
  const [kind = '', ...rest] = split(value, ';')
  const params: [string, string][] = []
  for (const p of rest) {
    const eq = p.indexOf('=')
    if (eq > 0) params.push([p.slice(0, eq).trim().toLowerCase(), unquote(p.slice(eq + 1).trim())])
  }
  return `(${quote(kind.trim().toLowerCase())} ${paramList(params)})`
}

const languageOf = (fields: Header[]) => {
  const langs = (first(fields, 'content-language') ?? '').split(',').map((l) => l.trim()).filter(Boolean)
  return langs.length === 0 ? 'NIL' : langs.length === 1 ? quote(langs[0]!) : `(${langs.map(quote).join(' ')})`
}

function countLines(buf: Uint8Array, from: number, to: number): number {
  let n = 0
  for (let i = from; i < to; i++) if (buf[i] === LF) n++
  return n
}

function indexOf(buf: Uint8Array, needle: Uint8Array, from: number, to: number): number {
  outer: for (let i = from; i <= to - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (buf[i + j] !== needle[j]) continue outer
    return i
  }
  return -1
}

/** Reads the whole message once: its structure, its section map, and its header block. */
export function describe(raw: Uint8Array): ImapMeta {
  const parts: Record<string, Range> = {}
  const messages: Record<string, Range> = {}

  // `asMessage`: this entity is a message (the outer one, or one inside a message/rfc822 part) and `path` names the
  // part that holds it ('' for the outer message); otherwise the entity is the part `path` itself.
  const entity = (from: number, to: number, path: string, asMessage: boolean, depth: number): string => {
    const { fields, bodyStart } = readHeaders(raw, from, to)
    const { type, subtype, params } = typed(first(fields, 'content-type'), 'text/plain')
    const boundary = params.find(([k]) => k === 'boundary')?.[1]
    const extension = `${dispositionOf(fields)} ${languageOf(fields)} ${nstring(first(fields, 'content-location'))}`

    if (type === 'multipart' && boundary && depth < MAX_DEPTH) {
      const delimiter = new TextEncoder().encode(`--${boundary}`)
      // A delimiter only counts at the start of a line.
      const next = (at: number) => {
        let pos = indexOf(raw, delimiter, at, to)
        while (pos > from && raw[pos - 1] !== LF) pos = indexOf(raw, delimiter, pos + 1, to)
        return pos
      }
      const children: string[] = []
      let pos = next(bodyStart)
      while (pos >= 0) {
        const after = pos + delimiter.length
        if (raw[after] === 45 && raw[after + 1] === 45) break
        let start = after
        while (start < to && raw[start] !== LF) start++
        start = Math.min(start + 1, to)
        const following = next(start)
        // The line break before a delimiter belongs to the delimiter, not to the part.
        let end = following < 0 ? to : following - 1
        if (end > start && raw[end - 1] === CR) end--
        const childPath = path ? `${path}.${children.length + 1}` : `${children.length + 1}`
        children.push(entity(start, Math.max(start, end), childPath, false, depth + 1))
        pos = following
      }
      if (children.length) {
        if (!asMessage) parts[path] = [from, bodyStart, to]
        return `(${children.join('')} ${quote(subtype)} ${paramList(params)} ${extension})`
      }
    }

    const own = asMessage ? (path ? `${path}.1` : '1') : path
    parts[own] = [from, bodyStart, to]
    const encoding = (first(fields, 'content-transfer-encoding') ?? '7bit').trim().toLowerCase()
    const basic = `${quote(type)} ${quote(subtype)} ${paramList(params)} ${nstring(first(fields, 'content-id'))} ${nstring(first(fields, 'content-description'))} ${quote(encoding)} ${to - bodyStart}`
    let middle = ''
    if (type === 'message' && subtype === 'rfc822' && !/base64|quoted-printable/.test(encoding) && depth < MAX_DEPTH) {
      const inner = readHeaders(raw, bodyStart, to)
      messages[own] = [bodyStart, inner.bodyStart, to]
      middle = ` ${envelope(inner.fields)} ${entity(bodyStart, to, own, true, depth + 1)} ${countLines(raw, bodyStart, to)}`
    } else if (type === 'text') middle = ` ${countLines(raw, bodyStart, to)}`
    return `(${basic}${middle} ${nstring(first(fields, 'content-md5'))} ${extension})`
  }

  const structure = entity(0, raw.length, '', true, 0)
  const { bodyStart } = readHeaders(raw, 0, raw.length)
  return { v: 1, size: raw.length, bodyStart, head: bodyStart <= MAX_HEAD ? latin1.decode(raw.subarray(0, bodyStart)) : null, structure, parts, messages }
}

// ---------------------------------------------------------------------------------------------------------------
// Sections: BODY[...]

export type Section =
  /** Bytes [start, end) of the raw message. */
  | { kind: 'bytes'; start: number; end: number }
  /** Some header fields of the header block at [start, end): the named ones, or with `not` all the others. */
  | { kind: 'fields'; start: number; end: number; names: string[]; not: boolean }

/** Where a section such as "", "HEADER", "1.2", "2.MIME" or "HEADER.FIELDS (From To)" is. null: no such section. */
export function section(meta: ImapMeta, spec: string): Section | null {
  const m = /^(\d+(?:\.\d+)*)?\.?(HEADER\.FIELDS\.NOT|HEADER\.FIELDS|HEADER|TEXT|MIME)?\s*(?:\(([^)]*)\))?$/i.exec(spec.trim())
  if (!m) return null
  const path = m[1]
  const what = m[2]?.toUpperCase()
  const names = (m[3] ?? '').split(/\s+/).map((n) => unquote(n).toLowerCase()).filter(Boolean)
  let message: Range
  if (!path) message = [0, meta.bodyStart, meta.size]
  else if (!what || what === 'MIME') {
    const part = meta.parts[path]
    if (!part) return null
    return what === 'MIME' ? { kind: 'bytes', start: part[0], end: part[1] } : { kind: 'bytes', start: part[1], end: part[2] }
  } else {
    const inner = meta.messages[path]
    if (!inner) return null
    message = inner
  }
  if (!what) return { kind: 'bytes', start: message[0], end: message[2] }
  if (what === 'HEADER') return { kind: 'bytes', start: message[0], end: message[1] }
  if (what === 'TEXT') return { kind: 'bytes', start: message[1], end: message[2] }
  if (what === 'MIME') return null
  return { kind: 'fields', start: message[0], end: message[1], names, not: what === 'HEADER.FIELDS.NOT' }
}

/** The named fields of a header block (or all but them), as they were written, with the blank line that ends a header. */
export function pickFields(head: string, names: string[], not: boolean): string {
  return parseFields(head).filter((f) => names.includes(f.name) !== not).map((f) => (f.raw.endsWith('\n') ? f.raw : `${f.raw}\r\n`)).join('') + '\r\n'
}
