// Where each part of a raw message sits (docs/mailbox-store-plan.md: attachments are stored once, inside the raw
// message, and read back by position). One pass over the bytes, following multipart boundaries; nothing is decoded
// until a part is asked for. Pure: no runtime imports, so `pnpm test` runs it directly under Node.

export type PartEncoding = 'base64' | 'quoted-printable' | 'plain'

/** A leaf part of a message: its headers' gist, and where its body is in the raw bytes. */
export type MimePart = {
  /** Position in the tree, such as "1.2.1". */
  path: string
  /** Lowercase media type, such as "application/pdf". */
  type: string
  name: string | null
  disposition: 'attachment' | 'inline' | null
  contentId: string | null
  encoding: PartEncoding
  /** The body's first byte and length in the raw message, still encoded. */
  start: number
  length: number
}

const latin1 = new TextDecoder('latin1')

/** Nesting deeper than this is not followed: the part is kept whole as one leaf. */
const MAX_DEPTH = 20

function indexOf(buf: Uint8Array, needle: Uint8Array, from: number, to: number): number {
  const first = needle[0]!
  outer: for (let i = from; i <= to - needle.length; i++) {
    if (buf[i] !== first) continue
    for (let j = 1; j < needle.length; j++) if (buf[i + j] !== needle[j]) continue outer
    return i
  }
  return -1
}

/** Where the header block ends and the body starts: after the first empty line. */
function headerEnd(buf: Uint8Array, from: number, to: number): [end: number, body: number] {
  // A part with no headers at all starts with the empty line.
  if (buf[from] === 10) return [from, from + 1]
  if (buf[from] === 13 && buf[from + 1] === 10) return [from, from + 2]
  for (let i = from; i < to - 1; i++) {
    if (buf[i] !== 10) continue
    if (buf[i + 1] === 10) return [i + 1, i + 2]
    if (buf[i + 1] === 13 && buf[i + 2] === 10) return [i + 1, i + 3]
  }
  return [to, to]
}

function readHeaders(buf: Uint8Array, from: number, to: number): Record<string, string> {
  const text = latin1.decode(buf.subarray(from, to)).replace(/\r?\n[ \t]+/g, ' ')
  const headers: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const colon = line.indexOf(':')
    if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] ??= line.slice(colon + 1).trim()
  }
  return headers
}

/**
 * A parameter of a structured header (`boundary`, `filename`, `name`), quoted or not. The RFC 2231 forms that long
 * and non-ASCII file names use (`filename*=utf-8''r%C3%A9sum%C3%A9.pdf`, or split as `filename*0*=`, `filename*1*=`)
 * are joined and decoded, and win over a plain one. RFC 2047 words (`=?utf-8?Q?...?=`) are left for the caller.
 */
export function param(value: string | undefined, name: string): string | null {
  const re = new RegExp(`(?:^|;)\\s*${name}(\\*\\d+)?(\\*)?\\s*=\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|([^;\\s]+))`, 'gi')
  const pieces = [...(value ?? '').matchAll(re)].map((m) => ({
    index: m[1] ? Number(m[1].slice(1)) : -1,
    encoded: !!m[2],
    text: m[3] !== undefined ? m[3].replace(/\\(.)/g, '$1') : m[4]!,
  }))
  if (!pieces.length) return null
  const extended = pieces.filter((p) => p.index >= 0 || p.encoded).sort((a, b) => a.index - b.index)
  if (!extended.length) return pieces[0]!.text
  // charset'language'value on the first encoded piece; the rest are percent-encoded bytes in that charset.
  let charset = 'utf-8'
  const bytes: number[] = []
  extended.forEach((p, i) => {
    let text = p.text
    if (p.encoded && i === 0) {
      const m = /^([^']*)'[^']*'(.*)$/s.exec(text)
      if (m) {
        charset = m[1] || charset
        text = m[2]!
      }
    }
    for (let k = 0; k < text.length; k++) {
      const hi = p.encoded && text[k] === '%' ? hex(text.charCodeAt(k + 1)) : -1
      const lo = hi >= 0 ? hex(text.charCodeAt(k + 2)) : -1
      if (hi >= 0 && lo >= 0) {
        bytes.push((hi << 4) | lo)
        k += 2
      } else bytes.push(text.charCodeAt(k) & 0xff)
    }
  })
  try {
    return new TextDecoder(charset).decode(new Uint8Array(bytes))
  } catch {
    return new TextDecoder('utf-8').decode(new Uint8Array(bytes))
  }
}

function encodingOf(value: string | undefined): PartEncoding {
  const v = (value ?? '').trim().toLowerCase()
  return v === 'base64' ? 'base64' : v === 'quoted-printable' ? 'quoted-printable' : 'plain'
}

/** Every leaf part of the message, in order. A multipart whose boundary can't be found is returned as one leaf. */
export function locateParts(buf: Uint8Array, from = 0, to = buf.length, out: MimePart[] = [], path = '1', depth = 0): MimePart[] {
  const [hEnd, bodyStart] = headerEnd(buf, from, to)
  const h = readHeaders(buf, from, hEnd)
  const type = (h['content-type'] ?? 'text/plain').split(';')[0]!.trim().toLowerCase() || 'text/plain'
  const boundary = param(h['content-type'], 'boundary')

  if (type.startsWith('multipart/') && boundary && depth < MAX_DEPTH) {
    const delimiter = new TextEncoder().encode(`--${boundary}`)
    // A delimiter only counts at the start of a line.
    const next = (at: number) => {
      let pos = indexOf(buf, delimiter, at, to)
      while (pos > from && buf[pos - 1] !== 10) pos = indexOf(buf, delimiter, pos + 1, to)
      return pos
    }
    let pos = next(bodyStart)
    let n = 0
    while (pos >= 0) {
      const after = pos + delimiter.length
      if (buf[after] === 45 && buf[after + 1] === 45) break // "--boundary--" closes the multipart
      let partStart = after
      while (partStart < to && buf[partStart] !== 10) partStart++
      partStart = Math.min(partStart + 1, to)
      const following = next(partStart)
      // The line break before a delimiter belongs to the delimiter, not to the part.
      let partEnd = following < 0 ? to : following - 1
      if (partEnd > partStart && buf[partEnd - 1] === 13) partEnd--
      locateParts(buf, partStart, Math.max(partStart, partEnd), out, `${path}.${++n}`, depth + 1)
      pos = following
    }
    if (n) return out
  }

  const disposition = (h['content-disposition'] ?? '').split(';')[0]!.trim().toLowerCase()
  out.push({
    path,
    type,
    name: param(h['content-disposition'], 'filename') ?? param(h['content-type'], 'name'),
    disposition: disposition === 'attachment' || disposition === 'inline' ? disposition : null,
    contentId: h['content-id']?.replace(/^<|>$/g, '') ?? null,
    encoding: encodingOf(h['content-transfer-encoding']),
    start: bodyStart,
    length: Math.max(0, to - bodyStart),
  })
  return out
}

/** Whether a part is read as message text rather than kept as a file. */
export function isBodyText(part: MimePart): boolean {
  return part.disposition !== 'attachment' && (part.type === 'text/plain' || part.type === 'text/html') && !part.name
}

const B64 = (() => {
  const table = new Int8Array(256).fill(-1)
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  for (let i = 0; i < alphabet.length; i++) table[alphabet.charCodeAt(i)] = i
  return table
})()

function decodeBase64(src: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.floor((src.length * 3) / 4) + 3)
  let o = 0
  let acc = 0
  let bits = 0
  for (let i = 0; i < src.length; i++) {
    const v = B64[src[i]!]!
    if (v < 0) continue // line breaks, padding and anything else that isn't part of the alphabet
    acc = (acc << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[o++] = (acc >> bits) & 0xff
    }
  }
  return out.subarray(0, o)
}

const hex = (c: number) => (c >= 48 && c <= 57 ? c - 48 : c >= 65 && c <= 70 ? c - 55 : c >= 97 && c <= 102 ? c - 87 : -1)

function decodeQuotedPrintable(src: Uint8Array): Uint8Array {
  const out = new Uint8Array(src.length)
  let o = 0
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!
    if (c !== 61) {
      out[o++] = c
      continue
    }
    // "=" then a line break is a soft break: the line continues.
    if (src[i + 1] === 13 && src[i + 2] === 10) i += 2
    else if (src[i + 1] === 10) i += 1
    else {
      const hi = hex(src[i + 1] ?? 0)
      const lo = hex(src[i + 2] ?? 0)
      if (hi >= 0 && lo >= 0) {
        out[o++] = (hi << 4) | lo
        i += 2
      } else out[o++] = c
    }
  }
  return out.subarray(0, o)
}

/** A part's content, decoded from the bytes at its position (the whole message, or just that range of it). */
export function decodePart(bytes: Uint8Array, encoding: PartEncoding): Uint8Array {
  return encoding === 'base64' ? decodeBase64(bytes) : encoding === 'quoted-printable' ? decodeQuotedPrintable(bytes) : bytes
}

/**
 * The message with the bodies of its file parts cut out: headers, structure and text stay, so a parser reads it
 * using memory near the size of the text instead of the attachments. Not a valid copy of the message.
 */
export function withoutFiles(buf: Uint8Array, parts: MimePart[]): Uint8Array {
  const cut = parts.filter((p) => !isBodyText(p) && p.length > 0).sort((a, b) => a.start - b.start)
  if (!cut.length) return buf
  const size = buf.length - cut.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(size)
  let o = 0
  let at = 0
  for (const p of cut) {
    out.set(buf.subarray(at, p.start), o)
    o += p.start - at
    at = p.start + p.length
  }
  out.set(buf.subarray(at), o)
  return out
}
