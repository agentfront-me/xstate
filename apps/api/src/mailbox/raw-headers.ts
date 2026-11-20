// Changes to the header block of a raw message, for mail a mail app hands over ready-made (./outbound-raw.ts). The
// body is never read or copied apart from the one move into the new buffer.

const CR = 13
const LF = 10

/** Where the header block ends: the index just past its last line break (the blank line, or the end, follows). */
export function headerEnd(raw: Uint8Array): number {
  for (let i = 0; i < raw.length - 1; i++) {
    if (raw[i] !== LF) continue
    if (raw[i + 1] === LF) return i + 1
    if (raw[i + 1] === CR && raw[i + 2] === LF) return i + 1
  }
  return raw.length
}

/** The header block as its fields, each with its folded continuation lines and line break(s). */
function fields(head: string): { name: string; text: string }[] {
  const out: { name: string; text: string }[] = []
  for (const line of head.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const last = out[out.length - 1]
    if (last && /^[ \t]/.test(line)) last.text += line
    else out.push({ name: line.slice(0, Math.max(line.indexOf(':'), 0)).trim().toLowerCase(), text: line })
  }
  return out
}

const latin1 = new TextDecoder('latin1')

/** True when the message has a header of that name (lowercase). */
export function hasHeader(raw: Uint8Array, name: string): boolean {
  return fields(latin1.decode(raw.subarray(0, headerEnd(raw)))).some((f) => f.name === name)
}

/**
 * The message with every header named in `remove` (lowercase; folded lines included) taken out and the lines in
 * `add` (ASCII, without line breaks) put first. Only the header block changes.
 */
export function rewriteHeaders(raw: Uint8Array, remove: string[], add: string[]): Uint8Array {
  const end = headerEnd(raw)
  const kept = fields(latin1.decode(raw.subarray(0, end))).filter((f) => !remove.includes(f.name))
  let head = add.map((line) => `${line}\r\n`).join('') + kept.map((f) => f.text).join('')
  // A header block with no line break at its end (a message that is only headers) gets one, so added lines stay lines.
  if (head && !head.endsWith('\n')) head += '\r\n'
  const out = new Uint8Array(head.length + raw.length - end)
  for (let i = 0; i < head.length; i++) out[i] = head.charCodeAt(i) & 0xff
  out.set(raw.subarray(end), head.length)
  return out
}
