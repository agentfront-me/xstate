// Compares our own reading of a raw message (./parse.ts) with the mail server's, while both exist: the shadow copy
// runs this on every message, so parsing is tried on all the real mail before anything depends on it. Pure: no
// runtime imports, so `pnpm test` runs it directly under Node.

import type { StoreAddress } from './query.ts'

type Read = { subject: string; from: StoreAddress[]; to: StoreAddress[]; text: string }

/** Characters that show nothing: marketing mail pads its preview with runs of them, and parsers break those runs differently. */
const INVISIBLE = /[\u00ad\u034f\u200b-\u200f\u2060\ufeff]/g
const squash = (s: string) => s.replace(INVISIBLE, '').replace(/\s+/g, ' ').trim()
const emails = (list: StoreAddress[]) => list.map((a) => a.email.toLowerCase()).sort().join(',')
/** Text compared up to here: enough to tell a different body from a different ending. */
const COMPARED_CHARS = 2000

/**
 * Which fields our reading of a message differs in from the mail server's: 'subject', 'from', 'to', 'text'.
 * Empty when they agree. Whitespace is not compared.
 */
export function parseDifferences(ours: Read, theirs: Read): string[] {
  const diff: string[] = []
  if (squash(ours.subject) !== squash(theirs.subject)) diff.push('subject')
  if (emails(ours.from) !== emails(theirs.from)) diff.push('from')
  if (emails(ours.to) !== emails(theirs.to)) diff.push('to')
  if (squash(ours.text).slice(0, COMPARED_CHARS) !== squash(theirs.text).slice(0, COMPARED_CHARS)) diff.push('text')
  return diff
}

/**
 * A message's readable body: its plain-text part, or its HTML part as text when the plain part is missing or empty
 * (some senders include an empty one). `fromHtml` turns HTML into text.
 */
export function readableText(text: string | undefined, html: string | undefined, fromHtml: (html: string) => string): string {
  if (text?.trim()) return text
  return html ? fromHtml(html) : (text ?? '')
}
