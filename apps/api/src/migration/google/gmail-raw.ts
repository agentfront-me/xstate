// Reading Gmail messages without holding them several times over. See the Workspace Migration Plan, "Gmail to
// Stalwart".
//
// messages.get?format=raw answers with JSON whose `raw` field is the whole message, base64url-encoded. Reading that
// with res.json() keeps the response text, the parsed string and the decoded bytes in memory at once (almost four
// times the message), and Gmail doesn't send a Content-Length to check the size against first. readRawMessage
// streams the body instead: the small fields around `raw` are kept as JSON, and `raw` is decoded as it arrives into
// one buffer, so a message costs about its own size. It stops reading once `raw` is past `maxRawBytes`.
//
// The batch helpers ask Gmail for many messages' sizes in one request (format=minimal), so a job knows how big a
// message is before downloading it.
//
// No Workers-only imports here: the tests run it under Node.

/** The message is bigger than the caller allowed. `bytes`: how much of it had been read when reading stopped. */
export class RawTooLarge extends Error {
  readonly bytes: number
  constructor(bytes: number) {
    super(`over ${bytes} bytes`)
    this.name = 'RawTooLarge'
    this.bytes = bytes
  }
}

const B64 = (() => {
  const t = new Int8Array(256).fill(-1)
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  for (let i = 0; i < abc.length; i++) t[abc.charCodeAt(i)] = i
  t[43] = 62 // +
  t[45] = 62 // -
  t[47] = 63 // /
  t[95] = 63 // _
  return t
})()

const QUOTE = 34
const BACKSLASH = 92
/** `"raw"`, the key whose value is the message. */
const RAW_KEY = [QUOTE, 114, 97, 119, QUOTE]

/**
 * Base64 (standard or url-safe, padded or not) decoded a character at a time into a buffer that grows only if the
 * size hint was short. JSON escapes inside the string (Google writes "=" as =) are undone first.
 */
class Decoder {
  out: Uint8Array
  length = 0
  chars = 0
  private acc = 0
  private n = 0
  private escape: number[] | null = null

  constructor(sizeHint: number) {
    this.out = new Uint8Array(Math.max(1024, Math.ceil(sizeHint * 1.02) + 64))
  }

  /** One byte of the JSON string. */
  push(b: number) {
    if (this.escape) {
      this.escape.push(b)
      const e = this.escape
      if (e[0] !== 117 /* u */) {
        this.escape = null
        return this.char(e[0]!)
      }
      if (e.length < 5) return
      this.escape = null
      return this.char(parseInt(String.fromCharCode(e[1]!, e[2]!, e[3]!, e[4]!), 16))
    }
    if (b === BACKSLASH) {
      this.escape = []
      return
    }
    this.char(b)
  }

  private char(c: number) {
    const v = c < 256 ? B64[c]! : -1
    if (v < 0) return // padding, line breaks
    this.chars++
    this.acc = (this.acc << 6) | v
    if (++this.n === 4) {
      this.room(3)
      this.out[this.length++] = (this.acc >> 16) & 255
      this.out[this.length++] = (this.acc >> 8) & 255
      this.out[this.length++] = this.acc & 255
      this.acc = 0
      this.n = 0
    }
  }

  finish(): Uint8Array {
    if (this.n === 2) {
      this.room(1)
      this.out[this.length++] = (this.acc >> 4) & 255
    } else if (this.n === 3) {
      this.room(2)
      this.out[this.length++] = (this.acc >> 10) & 255
      this.out[this.length++] = (this.acc >> 2) & 255
    }
    this.n = 0
    return this.out.subarray(0, this.length)
  }

  private room(k: number) {
    if (this.length + k <= this.out.length) return
    const bigger = new Uint8Array(Math.max(this.out.length * 2, this.length + k))
    bigger.set(this.out.subarray(0, this.length))
    this.out = bigger
  }
}

/**
 * Reads a messages.get?format=raw response. `meta` is every field but `raw` (which is "" there); `raw` is the
 * decoded message, a view that may sit in a slightly larger buffer. Throws RawTooLarge, after cancelling the body,
 * once the message is past `maxRawBytes`. `sizeHint` (Gmail's sizeEstimate) sizes the buffer up front.
 */
export async function readRawMessage(
  body: ReadableStream<Uint8Array>,
  options: { maxRawBytes?: number; sizeHint?: number } = {},
): Promise<{ meta: Record<string, unknown>; raw: Uint8Array }> {
  const maxChars = options.maxRawBytes === undefined ? Infinity : Math.ceil((options.maxRawBytes * 4) / 3) + 4
  const meta: number[] = []
  let mode: 'json' | 'key' | 'raw' = 'json'
  let decoder: Decoder | null = null
  let escaped = false
  const reader = body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      for (let i = 0; i < value.length; i++) {
        const b = value[i]!
        if (mode === 'raw') {
          if (b === QUOTE && !escaped) {
            meta.push(QUOTE)
            mode = 'json'
            continue
          }
          escaped = !escaped && b === BACKSLASH
          decoder!.push(b)
          if (decoder!.chars > maxChars) throw new RawTooLarge(Math.floor((decoder!.chars * 3) / 4))
        } else if (mode === 'key') {
          // Between "raw" and its value: whitespace, the colon, then the opening quote.
          if (b === QUOTE) {
            meta.push(58 /* : */, QUOTE)
            decoder = new Decoder(options.sizeHint ?? 0)
            escaped = false
            mode = 'raw'
          }
        } else {
          meta.push(b)
          if (b === QUOTE && meta.length >= 5 && RAW_KEY.every((k, j) => meta[meta.length - 5 + j] === k)) mode = 'key'
        }
      }
    }
  } catch (err) {
    await reader.cancel().catch(() => {})
    throw err
  } finally {
    reader.releaseLock()
  }
  const parsed = JSON.parse(new TextDecoder().decode(new Uint8Array(meta))) as Record<string, unknown>
  return { meta: parsed, raw: decoder ? decoder.finish() : new Uint8Array(0) }
}

// ---------------------------------------------------------------------------------------------------------------
// Batch: many messages' sizes in one request

/** A multipart/mixed batch body asking for each message's size (format=minimal). */
export function sizeBatchBody(ids: string[], boundary: string): string {
  const parts = ids.map(
    (id, i) =>
      `--${boundary}\r\nContent-Type: application/http\r\nContent-ID: <s${i}>\r\n\r\n` +
      `GET /gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=minimal&fields=id,sizeEstimate\r\n\r\n`,
  )
  return `${parts.join('')}--${boundary}--\r\n`
}

/** Message id → size from a batch response. Parts that failed (a deleted message, a rate limit) are left out. */
export function parseSizeBatch(text: string, contentType: string): Map<string, number> {
  const out = new Map<string, number>()
  const boundary = /boundary="?([^";]+)"?/i.exec(contentType)?.[1]
  if (!boundary) return out
  for (const part of text.split(`--${boundary}`)) {
    const status = /HTTP\/[\d.]+ (\d{3})/.exec(part)
    if (status?.[1] !== '200') continue
    const start = part.indexOf('{')
    const end = part.lastIndexOf('}')
    if (start < 0 || end < start) continue
    try {
      const r = JSON.parse(part.slice(start, end + 1)) as { id?: string; sizeEstimate?: number }
      if (r.id && typeof r.sizeEstimate === 'number') out.set(r.id, r.sizeEstimate)
    } catch {
      // A part we can't read: its size stays unknown.
    }
  }
  return out
}
