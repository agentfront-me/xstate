// Finding the quoted history in a reply ("On … wrote:" and what follows), so the reader can fold it away.

const ATTRIBUTION = /^\s*On\b.*\bwrote:\s*$/i
const ATTRIBUTION_START = /^\s*On\b.{6,}/
const OUTLOOK_HEADER = /^\s*(-{2,}\s*Original Message\s*-{2,}|_{20,})\s*$/i

/**
 * Splits a plain-text body into what was written and the quoted history under it ("On … wrote:" and "> " lines,
 * or an Outlook "Original Message" block). Returns quote: '' when there is none, or nothing would be left.
 */
export function splitQuote(text: string): { body: string; quote: string } {
  const lines = text.split('\n')
  const quoted = (from: number) => lines.slice(from).every((l) => !l.trim() || /^\s*>/.test(l))
  let cut = -1
  for (let i = 0; i < lines.length && cut < 0; i++) {
    const line = lines[i]!
    const next = lines[i + 1] ?? ''
    if (ATTRIBUTION.test(line) || OUTLOOK_HEADER.test(line)) cut = i
    // Long attributions wrap: "On Tue, … Name <a@b.c>" then "wrote:" on the next line.
    else if (ATTRIBUTION_START.test(line) && /^\s*\S*.*wrote:\s*$/i.test(next) && !/^\s*>/.test(line)) cut = i
    else if (/^\s*From:\s/.test(line) && /^\s*(Sent|Date):\s/.test(next)) cut = i
    else if (/^\s*>/.test(line) && quoted(i)) cut = i
  }
  if (cut <= 0) return { body: text, quote: '' }
  const body = lines.slice(0, cut).join('\n').trimEnd()
  return body.trim() ? { body, quote: lines.slice(cut).join('\n').trim() } : { body: text, quote: '' }
}

/** Where mail apps put the quoted history in an HTML reply (Spark, Apple Mail, Gmail, Outlook, Thunderbird, Yahoo). */
const HTML_QUOTE = [
  '[name="messageReplySection"]',
  '.gmail_quote',
  '#appendonsend',
  '[id^="divRplyFwdMsg"]',
  '.moz-cite-prefix',
  '.yahoo_quoted',
  'blockquote[type="cite"]',
].join(',')

/** Simple mail (no layout colours, tables or images) reads better in the app's own colours than in a white box. */
export const isPlainHtml = (html: string) => !/<table|bgcolor\s*=|background(-color|-image)?\s*:|<img/i.test(html)

/**
 * Marks the quoted history in an HTML body (and the "On … wrote:" line above it) with data-xq, so CSS can hide
 * it. Returns false when there is none, or hiding it would leave nothing to read.
 */
export function markQuote(doc: Document): boolean {
  const quote = doc.body.querySelector(HTML_QUOTE)
  if (!quote) return false
  const marked: ChildNode[] = [quote]
  for (let n = quote.nextSibling; n; n = n.nextSibling) marked.push(n)
  let prev = quote.previousSibling
  while (prev && ((prev.nodeType === Node.TEXT_NODE && !prev.textContent?.trim()) || prev.nodeName === 'BR')) prev = prev.previousSibling
  if (prev && /wrote:\s*$/i.test(prev.textContent ?? '')) marked.push(prev)
  for (const node of marked) {
    let el: Element
    if (node.nodeType === Node.ELEMENT_NODE) el = node as Element
    else {
      el = doc.createElement('span')
      node.replaceWith(el)
      el.append(node)
    }
    el.setAttribute('data-xq', '')
  }
  doc.body.classList.add('xq-hide')
  if (!doc.body.innerText.trim()) {
    doc.body.classList.remove('xq-hide')
    return false
  }
  return true
}
