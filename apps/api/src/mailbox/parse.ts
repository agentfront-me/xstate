// Reads a raw message the way the mailbox store will once mail arrives without Stalwart: where its parts are
// (./mime.ts) and, through postal-mime, its headers and text. The parser is given the message with the files cut
// out, so memory stays near the size of the text (a 35 MB message otherwise needs about 126 MB; see the spike
// findings in docs/mailbox-store-plan.md).

import PostalMime from 'postal-mime'
import { htmlToText } from '../mailserver/messages'
import { readableText } from './compare'
import { locateParts, withoutFiles, type MimePart } from './mime'
import type { StoreAddress } from './query'

export type ParsedMessage = {
  parts: MimePart[]
  subject: string
  from: StoreAddress[]
  to: StoreAddress[]
  messageId: string | null
  inReplyTo: string | null
  references: string | null
  /** The readable body: the plain-text part, or the HTML part as text. */
  text: string
}

type PostalAddress = { name?: string; address?: string; group?: PostalAddress[] }

function addresses(list: PostalAddress | PostalAddress[] | undefined): StoreAddress[] {
  const flat = (Array.isArray(list) ? list : list ? [list] : []).flatMap((a) => (a.group ? a.group : [a]))
  return flat.filter((a) => a.address).map((a) => ({ name: a.name || null, email: a.address! }))
}

export async function parseRaw(raw: Uint8Array): Promise<ParsedMessage> {
  const parts = locateParts(raw)
  const mail = await PostalMime.parse(withoutFiles(raw, parts))
  return {
    parts,
    subject: mail.subject ?? '',
    from: addresses(mail.from as PostalAddress | undefined),
    to: addresses(mail.to as PostalAddress[] | undefined),
    messageId: mail.messageId ?? null,
    inReplyTo: mail.inReplyTo ?? null,
    references: mail.references ?? null,
    text: readableText(mail.text, mail.html, htmlToText),
  }
}
