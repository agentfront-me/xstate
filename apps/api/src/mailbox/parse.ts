// Reads a raw message for the mailbox store: where its parts are
// (./mime.ts) and, through postal-mime, its headers and text. The parser is given the message with the files cut
// out, so memory stays near the size of the text (a 35 MB message otherwise needs about 126 MB; see the spike
// findings in docs/mailbox-store-plan.md).

import PostalMime, { decodeWords } from 'postal-mime'
import { htmlToText } from '../mailserver/html-text'
import { readableText } from './compare'
import { isBodyText, locateParts, withoutFiles, type MimePart } from './mime'
import type { StoreAddress } from './query'

export type ParsedMessage = {
  parts: MimePart[]
  subject: string
  from: StoreAddress[]
  to: StoreAddress[]
  cc: StoreAddress[]
  bcc: StoreAddress[]
  replyTo: StoreAddress[]
  /** The Date header as an ISO time, or null when it is missing or doesn't parse. */
  sentAt: string | null
  /** Without angle brackets, as JMAP gives it. */
  messageId: string | null
  inReplyTo: string | null
  references: string | null
  /** The readable body: the plain-text part, or the HTML part as text. */
  text: string
  html: string | null
  /** Each header's first value by lowercase name, decoded: what rules and the agents' loop guard read. */
  headers: Record<string, string>
}

type PostalAddress = { name?: string; address?: string; group?: PostalAddress[] }

function addresses(list: PostalAddress | PostalAddress[] | undefined): StoreAddress[] {
  const flat = (Array.isArray(list) ? list : list ? [list] : []).flatMap((a) => (a.group ? a.group : [a]))
  return flat.filter((a) => a.address).map((a) => ({ name: a.name || null, email: a.address! }))
}

export async function parseRaw(raw: Uint8Array): Promise<ParsedMessage> {
  const parts = locateParts(raw)
  const mail = await PostalMime.parse(withoutFiles(raw, parts))
  const sentAt = mail.date && !Number.isNaN(Date.parse(mail.date)) ? new Date(mail.date).toISOString().replace('.000Z', 'Z') : null
  return {
    parts,
    subject: mail.subject ?? '',
    from: addresses(mail.from as PostalAddress | undefined),
    to: addresses(mail.to as PostalAddress[] | undefined),
    cc: addresses(mail.cc as PostalAddress[] | undefined),
    bcc: addresses(mail.bcc as PostalAddress[] | undefined),
    replyTo: addresses(mail.replyTo as PostalAddress[] | undefined),
    sentAt,
    messageId: mail.messageId?.replace(/^\s*<|>\s*$/g, '') || null,
    inReplyTo: mail.inReplyTo ?? null,
    references: mail.references ?? null,
    text: readableText(mail.text, mail.html, htmlToText),
    html: mail.html ?? null,
    headers: firstHeaders(mail.headers as { key: string; value: string }[] | undefined),
  }
}

function firstHeaders(list: { key: string; value: string }[] | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const h of list ?? []) out[h.key.toLowerCase()] ??= h.value
  return out
}

/** The parts kept as files rather than read as text, in order: the attachments the raw copy records (./shadow.ts). */
export const fileParts = (parts: MimePart[]) => parts.filter((p) => !isBodyText(p) && p.length > 0)

/** A file part's name for people: RFC 2047 words decoded (RFC 2231 forms already are, by ./mime.ts). */
export const partName = (part: MimePart) => (part.name ? decodeWords(part.name).trim() || null : null)
