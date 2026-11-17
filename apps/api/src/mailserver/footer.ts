// The boilerplate senders put at the bottom of mail (copyright lines, "Powered by", privacy and unsubscribe
// links), taken off previews, search passages and the text we embed. It adds nothing to a summary, makes every
// message from one sender look alike to search, and costs agents tokens. No runtime imports: `pnpm test` runs
// this file directly under Node.

/** How far from the end a footer may start. Further up, a "©" or "Powered by" is more likely part of the message. */
const TAIL = 400
/** Text that must stay above a footer for it to be cut. */
const MIN_BODY = 40

/** A footer's first words: everything from here to the end of the text goes. */
const FOOTER_START = /(©|\(c\)\s*\d{4}|copyright\s+(©\s*)?\d{4}|all rights reserved|powered by\b)/gi

/** Lines that are only links or legal wording, wherever they are. Short lines only, so a sentence mentioning them stays. */
const NOISE_LINE =
  /^\s*[•|·\-–\s]*(unsubscribe|manage (your )?(email )?(preferences|subscriptions)|view (this email )?in (your |a )?browser|privacy policy|terms of (use|service)|update your preferences)([\s•|·\-–]*(unsubscribe|privacy policy|terms of (use|service)|preferences))*[\s•|·\-–.]*$/i
const NOISE_MAX = 120

/** The text without the sender's footer and link-only lines, with runs of blank lines squeezed to one. */
export function stripFooter(text: string): string {
  let out = text
    .split('\n')
    .filter((line) => !(line.length <= NOISE_MAX && NOISE_LINE.test(line)))
    .join('\n')
  const tailStart = Math.max(0, out.length - TAIL)
  let cut = -1
  for (const m of out.matchAll(FOOTER_START)) {
    if (m.index! >= tailStart) {
      cut = m.index!
      break
    }
  }
  // A short text that opens with "©" is the message itself, not a footer under one.
  if (cut >= MIN_BODY) out = out.slice(0, cut)
  return out.replace(/\n{3,}/g, '\n\n').trim()
}

/** One line for a list: footer off, whitespace collapsed, cut at a word near `max` characters. */
export function previewText(text: string, max: number): string {
  const flat = stripFooter(text).replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  const cut = flat.slice(0, max)
  const space = cut.lastIndexOf(' ')
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`
}
