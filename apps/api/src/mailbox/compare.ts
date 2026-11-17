// Compares our own reading of a raw message (./parse.ts) with the mail server's, while both exist: the shadow copy
// runs this on every message, so parsing is tried on all the real mail before anything depends on it. Pure: no
// runtime imports, so `pnpm test` runs it directly under Node.

import type { StoreAddress } from './query.ts'

type Read = { subject: string; from: StoreAddress[]; to: StoreAddress[]; text: string }

const squash = (s: string) => s.replace(/\s+/g, ' ').trim()
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
