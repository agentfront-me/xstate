// A store-held message as agents' email triggers read it (agents/email-trigger.ts): the same shape Stalwart's
// getTriggerEmails returns, built from our own reading of the raw message, so the rules, the loop guard and the task
// text work unchanged. Pure: no runtime imports, so `pnpm test` runs it directly under Node.

import type { TriggerEmail } from '../mailserver/stalwart/mail'
import type { StoreAddress } from './query'

/** Plain text handed to the agent, as Stalwart's trigger read caps it. */
const MAX_BODY_CHARS = 16_000

export type TriggerSource = {
  id: string
  threadId: string
  receivedAt: string
  hasAttachment: boolean
  subject: string
  from: StoreAddress[]
  to: StoreAddress[]
  cc: StoreAddress[]
  text: string
  /** First value of each header by lowercase name (mailbox/parse.ts). */
  headers: Record<string, string>
}

export function triggerEmailOf(m: TriggerSource): TriggerEmail {
  const header = (name: string) => m.headers[name]?.trim() || null
  const unsubscribe = header('list-unsubscribe')
  const text = m.text.length > MAX_BODY_CHARS ? m.text.slice(0, MAX_BODY_CHARS) : m.text
  return {
    id: m.id,
    threadId: m.threadId,
    mailboxIds: {},
    keywords: {},
    from: m.from,
    to: m.to,
    cc: m.cc,
    subject: m.subject,
    receivedAt: m.receivedAt,
    hasAttachment: m.hasAttachment,
    preview: text.replace(/\s+/g, ' ').trim().slice(0, 256),
    textBody: [{ partId: 'text' }],
    bodyValues: { text: { value: text, isTruncated: text.length < m.text.length } },
    'header:Auto-Submitted:asText': header('auto-submitted'),
    'header:Precedence:asText': header('precedence'),
    'header:List-Id:asText': header('list-id'),
    'header:List-Unsubscribe:asURLs': unsubscribe ? [...unsubscribe.matchAll(/<([^>]+)>/g)].map((u) => u[1]!) : null,
    'header:X-Autoreply:asText': header('x-autoreply'),
  }
}
