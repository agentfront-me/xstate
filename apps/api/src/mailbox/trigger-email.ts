// A message as agents' email triggers read it (agents/email-trigger.ts), built from our own reading of the raw
// message. The shape (JMAP-style field names) is the one the trigger rules, the loop guard and the task text were
// written against. Pure: no runtime imports, so `pnpm test` runs it directly under Node.

import type { StoreAddress } from './query'

type Address = { name: string | null; email: string }

/** A new message as an email trigger sees it: who and what, the headers that mark automated mail, and its text. */
export type TriggerEmail = {
  id: string
  threadId: string
  mailboxIds: Record<string, true>
  keywords: Record<string, true>
  from: Address[] | null
  to: Address[] | null
  cc: Address[] | null
  subject: string | null
  receivedAt: string
  hasAttachment: boolean
  preview: string
  textBody: { partId: string | null }[]
  bodyValues: Record<string, { value: string; isTruncated: boolean }>
  'header:Auto-Submitted:asText': string | null
  'header:Precedence:asText': string | null
  'header:List-Id:asText': string | null
  'header:List-Unsubscribe:asURLs': string[] | null
  'header:X-Autoreply:asText': string | null
}

/** Plain text handed to the agent is capped at this. */
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
