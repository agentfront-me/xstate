// Reading IMAP commands (RFC 3501 §9) for the mail-app sessions (relay/imap-session.ts): cutting the byte stream
// into commands, literals included, and a command into tokens. Pure: no runtime imports, so the tests run under Node.

export type Token =
  | { t: 'atom'; v: string }
  /** A quoted string or a literal. */
  | { t: 'string'; v: string }
  | { t: 'list'; items: Token[] }

export type Command = { tag: string; name: string; args: Token[] }

export type Next =
  /** No whole command yet. */
  | { kind: 'more' }
  /** A literal of `size` bytes is announced and not all here: the client waits for "+ ..." unless `sync` is false. */
  | { kind: 'literal'; size: number; sync: boolean; announcedAt: number }
  | { kind: 'command'; command: Command; consumed: number }
  /** Not IMAP we can read. `consumed` skips the line, so the session can answer BAD and carry on. */
  | { kind: 'bad'; tag: string; reason: string; consumed: number }

export const MAX_LINE = 64 * 1024
/** Phase 3 takes no messages in (APPEND comes later), so a literal is only ever a name or a search word. */
export const MAX_LITERAL = 1024 * 1024

const latin1 = new TextDecoder('latin1')
const utf8 = new TextDecoder()

type Segment = { text: string } | { literal: Uint8Array }

/** The next command in `buf`, if it is all there. */
export function nextCommand(buf: Uint8Array): Next {
  const segments: Segment[] = []
  let pos = 0
  for (;;) {
    let end = -1
    for (let i = pos; i < buf.length; i++) {
      if (buf[i] === 10) {
        end = i
        break
      }
    }
    if (end < 0) {
      if (buf.length - pos > MAX_LINE) return { kind: 'bad', tag: '*', reason: 'Line too long', consumed: buf.length }
      return { kind: 'more' }
    }
    const line = latin1.decode(buf.subarray(pos, end > pos && buf[end - 1] === 13 ? end - 1 : end))
    const announced = /\{(\d+)(\+?)\}$/.exec(line)
    if (!announced) {
      segments.push({ text: line })
      pos = end + 1
      break
    }
    const size = Number(announced[1])
    const first = segments.length ? '' : line
    if (size > MAX_LITERAL) return { kind: 'bad', tag: tagOf(first), reason: 'Too large', consumed: end + 1 }
    if (buf.length < end + 1 + size) return { kind: 'literal', size, sync: announced[2] !== '+', announcedAt: end + 1 }
    segments.push({ text: line.slice(0, announced.index) }, { literal: buf.subarray(end + 1, end + 1 + size) })
    pos = end + 1 + size
  }
  const first = (segments[0] as { text: string }).text
  try {
    const tokens = tokenize(segments)
    const [tag, name, ...args] = tokens
    if (tag?.t !== 'atom' || name?.t !== 'atom') return { kind: 'bad', tag: tagOf(first), reason: 'Missing command', consumed: pos }
    return { kind: 'command', command: { tag: tag.v, name: name.v.toUpperCase(), args }, consumed: pos }
  } catch (err) {
    return { kind: 'bad', tag: tagOf(first), reason: err instanceof Error ? err.message : 'Bad syntax', consumed: pos }
  }
}

const tagOf = (line: string) => /^[^\s(){%*"\\]+/.exec(line)?.[0] ?? '*'

/** Splits a command into atoms, strings and lists. A `[...]` section stays inside its atom, spaces and all. */
export function tokenize(segments: Segment[]): Token[] {
  const stack: Token[][] = [[]]
  const top = () => stack[stack.length - 1]!
  for (const segment of segments) {
    if ('literal' in segment) {
      top().push({ t: 'string', v: utf8.decode(segment.literal) })
      continue
    }
    const s = segment.text
    let i = 0
    while (i < s.length) {
      const c = s[i]!
      if (c === ' ') i++
      else if (c === '(') {
        stack.push([])
        i++
      } else if (c === ')') {
        if (stack.length === 1) throw new Error('Unbalanced parentheses')
        const items = stack.pop()!
        top().push({ t: 'list', items })
        i++
      } else if (c === '"') {
        let v = ''
        i++
        while (i < s.length && s[i] !== '"') {
          if (s[i] === '\\') i++
          v += s[i] ?? ''
          i++
        }
        if (i >= s.length) throw new Error('Unclosed quote')
        i++
        // Mail apps send UTF-8 in quoted strings (a folder name, a search word): read it as that.
        top().push({ t: 'string', v: utf8.decode(Uint8Array.from(v, (ch) => ch.charCodeAt(0) & 0xff)) })
      } else {
        let depth = 0
        const start = i
        while (i < s.length) {
          const ch = s[i]!
          if (ch === '[') depth++
          else if (ch === ']') depth = Math.max(depth - 1, 0)
          else if (depth === 0 && (ch === ' ' || ch === '(' || ch === ')')) break
          i++
        }
        top().push({ t: 'atom', v: s.slice(start, i) })
      }
    }
  }
  if (stack.length !== 1) throw new Error('Unbalanced parentheses')
  return stack[0]!
}

/** An atom or string's text, or null for a list or nothing. */
export const text = (token: Token | undefined): string | null => (token && token.t !== 'list' ? token.v : null)

/** A sequence set such as "1:3,7,10:*" as ranges; `*` is Infinity. null when it isn't one. */
export function parseSet(value: string): [number, number][] | null {
  const out: [number, number][] = []
  for (const piece of value.split(',')) {
    const m = /^(\d+|\*)(?::(\d+|\*))?$/.exec(piece)
    if (!m) return null
    const a = m[1] === '*' ? Infinity : Number(m[1])
    const b = m[2] === undefined ? a : m[2] === '*' ? Infinity : Number(m[2])
    if (a === 0 || b === 0) return null
    out.push([Math.min(a, b), Math.max(a, b)])
  }
  return out.length ? out : null
}

/**
 * The numbers of `all` (ascending) that a set names. `*` stands for the largest; as RFC 3501 has it, a range that
 * reaches `*` always includes the largest, even when it starts above it ("5000:*" in a folder that ends at 4000).
 */
export function pick(set: [number, number][], all: number[]): number[] {
  if (!all.length) return []
  const largest = all[all.length - 1]!
  const hit = new Set<number>()
  for (const [a, b] of set) {
    const lo = a === Infinity ? largest : Math.min(a, b === Infinity ? largest : b)
    const hi = b === Infinity ? largest : b
    // Binary search for the first number >= lo.
    let i = 0
    let j = all.length
    while (i < j) {
      const mid = (i + j) >> 1
      if (all[mid]! < lo) i = mid + 1
      else j = mid
    }
    for (; i < all.length && all[i]! <= hi; i++) hit.add(all[i]!)
  }
  return [...hit].sort((x, y) => x - y)
}
