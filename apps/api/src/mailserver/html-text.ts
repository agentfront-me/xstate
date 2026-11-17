// HTML to readable text, for messages sent without a text part. Agents, previews and search read it. No runtime
// imports, so `pnpm test` runs it directly under Node.

const NAMED: Record<string, string> = {
  nbsp: ' ', lt: '<', gt: '>', quot: '"', apos: "'", amp: '&', copy: '©', reg: '®', trade: '™', hellip: '…',
  mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', bull: '•', middot: '·', euro: '€',
  pound: '£', yen: '¥', cent: '¢', deg: '°', times: '×', zwnj: '\u200c', zwj: '\u200d', shy: '\u00ad',
}

function codePoint(n: number): string {
  // Not a character (out of range, or half of a surrogate pair): the replacement character, as browsers do.
  if (!Number.isFinite(n) || n <= 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return '\ufffd'
  return String.fromCodePoint(n)
}

/** Decodes character references: numeric (`&#847;`, `&#x2019;`) and the common named ones. Unknown names stay as written. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, ref: string) => {
    if (ref[0] === '#') return codePoint(ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10))
    return NAMED[ref.toLowerCase()] ?? whole
  })
}

export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
