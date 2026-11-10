// Pure helpers for triggers (no Workers APIs), so they run under node:test: the email loop guard and rules, and the
// task text a run gets from an email or a webhook payload.

import type { TriggerEmail } from '../mailserver/stalwart/mail'

export type EmailRules = { from: string; subjectContains: string; hasAttachment: boolean | null }

const BODY_CHARS = 8000
const AUTOMATED_SENDER = /^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|bounces?|notifications?)([+._-].*)?@/i

type Headers = Pick<
  TriggerEmail,
  'from' | 'header:Auto-Submitted:asText' | 'header:Precedence:asText' | 'header:List-Id:asText' | 'header:List-Unsubscribe:asURLs' | 'header:X-Autoreply:asText'
>

/** Why a message counts as automated mail (the loop guard), or null. */
export function automated(email: Headers): string | null {
  const auto = email['header:Auto-Submitted:asText']?.trim().toLowerCase()
  if (auto && auto !== 'no') return `Auto-Submitted: ${auto}`
  const precedence = email['header:Precedence:asText']?.trim().toLowerCase()
  if (precedence && ['bulk', 'junk', 'list', 'auto_reply'].includes(precedence)) return `Precedence: ${precedence}`
  if (email['header:X-Autoreply:asText']) return 'Auto-reply'
  if (email['header:List-Id:asText'] || email['header:List-Unsubscribe:asURLs']?.length) return 'Mailing list'
  const from = email.from?.[0]?.email ?? ''
  if (!from) return 'No sender'
  if (AUTOMATED_SENDER.test(from)) return `No-reply sender ${from}`
  return null
}

/** Whether a message passes a trigger's rules (sender, subject, attachment). */
export function matchesRules(rules: EmailRules, email: Pick<TriggerEmail, 'from' | 'subject' | 'hasAttachment'>): boolean {
  const from = (email.from ?? []).map((a) => `${a.name ?? ''} ${a.email}`.toLowerCase()).join(' ')
  if (rules.from && !from.includes(rules.from.toLowerCase())) return false
  if (rules.subjectContains && !(email.subject ?? '').toLowerCase().includes(rules.subjectContains.toLowerCase())) return false
  if (rules.hasAttachment !== null && email.hasAttachment !== rules.hasAttachment) return false
  return true
}

const address = (a: { name: string | null; email: string }) => (a.name ? `${a.name} <${a.email}>` : a.email)

/** The run's task for a message: who and what, ids to read the whole thread with, and the start of the text. */
export function emailTask(mailbox: { id: string; address: string }, email: TriggerEmail): string {
  const text = email.textBody
    .map((p) => (p.partId ? (email.bodyValues[p.partId]?.value ?? '') : ''))
    .join('\n')
    .trim()
  const body = text || email.preview
  const lines = [
    `New email in ${mailbox.address}`,
    `From: ${(email.from ?? []).map(address).join(', ')}`,
    `To: ${(email.to ?? []).map(address).join(', ')}`,
    ...(email.cc?.length ? [`Cc: ${email.cc.map(address).join(', ')}`] : []),
    `Subject: ${email.subject ?? '(no subject)'}`,
    `Received: ${email.receivedAt}`,
    ...(email.hasAttachment ? ['Has attachments.'] : []),
    // Ids on lines of their own, nothing after them: a model copies a trailing full stop into the id otherwise.
    `mailboxId: ${mailbox.id}`,
    `threadId: ${email.threadId}`,
    'To read the whole conversation, call email_get_thread with that mailboxId and threadId.',
    '',
    body.length > BODY_CHARS ? `${body.slice(0, BODY_CHARS)}\n[…message cut]` : body,
  ]
  return lines.join('\n')
}

function pick(payload: unknown, path: string): unknown {
  let value: unknown = payload
  for (const key of path.split('.')) {
    if (value === null || typeof value !== 'object') return undefined
    value = (value as Record<string, unknown>)[key]
  }
  return value
}

/** The task text for a webhook payload: the template with {{payload}} and {{field.path}} filled in. */
export function webhookTask(config: { name: string; template: string }, payload: unknown): string {
  const pretty = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2)
  const template = config.template.trim() || `Webhook "${config.name}" received this payload:\n\n{{payload}}`
  const text = template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, path: string) => {
    if (path === 'payload') return pretty
    const value = pick(payload, path.startsWith('payload.') ? path.slice(8) : path)
    if (value === undefined || value === null) return ''
    return typeof value === 'object' ? JSON.stringify(value) : String(value)
  })
  return text.slice(0, 20_000)
}
