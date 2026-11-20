// Sending a message a mail app hands over ready-made, over SMTP (docs/imap-smtp-relay-plan.md §5; the session is
// relay/smtp-session.ts). The app wrote the whole message, so unlike ./outbound.ts nothing is built here: the message
// is checked, its Bcc line taken off, sent through SES, and its Sent copy kept. Every check a message written in
// the app passes applies: the From address, the recipient cap and suppression list, the file-type rules, the
// attachment size cap, suspension and the sending limits.
//
// Memory: a Durable Object has 128 MB and a message can be 35 MB, so the raw message is never held twice for long.
// The parser gets it with the files cut out (./parse.ts), and each rewrite replaces the copy before it.

import type { MailboxRow } from '../db/mailboxes'
import * as accessDb from '../db/mailbox-access'
import * as eventsDb from '../db/email-events'
import { announce } from '../live/announce'
import { EmailError } from '../mailserver/errors'
import { MAX_ATTACHMENTS_BYTES, MAX_RECIPIENTS } from '../mailserver/messages'
import { reserveSend } from '../mailserver/sending'
import { organizationBucket } from '../storage/buckets'
import { putObject } from '../storage/r2'
import { queueMailEvent } from './events'
import { messageIds, previewOf, ulid } from './inbound'
import { decodePart, locateParts } from './mime'
import { safetyOf, type OutboundEnv } from './outbound'
import { fileParts, parseRaw, partName } from './parse'
import { hasHeader, rewriteHeaders } from './raw-headers'
import { rawKey } from './raw-key'
import { rfc5322Date } from './compose'
import { sendRaw, sesMessageId } from './ses-send'
import { store } from './stub'

/** The largest message taken over SMTP: the app's 25 MB of attachments once encoded, and room for the text. */
export const MAX_RAW_BYTES = 35 * 1024 * 1024

export type RawSend = {
  /** The message as the mail app sent it, after SMTP's dot-unstuffing. */
  raw: Uint8Array
  /** The addresses given with RCPT TO: who the message goes to, whatever its headers say. */
  recipients: string[]
}

const lower = (s: string) => s.trim().toLowerCase()

/** Sends the message from a store-held mailbox the caller may write to. Returns the Sent copy's id and SES's id. */
export async function sendRawFromStore(env: OutboundEnv, mailbox: MailboxRow, send: RawSend): Promise<{ id: string; sesId: string }> {
  let raw: Uint8Array | null = send.raw
  if (raw.length > MAX_RAW_BYTES) throw new EmailError('message_too_large', `A message can be at most ${MAX_RAW_BYTES / 1024 / 1024} MB`, 413)
  const recipients = [...new Set(send.recipients.map(lower).filter(Boolean))]
  if (!recipients.length) throw new EmailError('no_recipients', 'Add at least one recipient')
  if (recipients.length > MAX_RECIPIENTS) throw new EmailError('too_many_recipients', `A message can have at most ${MAX_RECIPIENTS} recipients`)

  const parsed = await parseRaw(raw)
  // Exactly one From address, and it must be the mailbox's own: its primary address or one of its aliases.
  const own = [mailbox.address, ...(JSON.parse(mailbox.aliases || '[]') as string[])].map(lower)
  const from = parsed.from.length === 1 ? lower(parsed.from[0]!.email) : ''
  if (!own.includes(from)) throw new EmailError('forbidden_from', `This mailbox may not send from ${from || 'that address'}. Use ${mailbox.address}.`, 403)

  // Addresses that hard-bounced before, or complained about this organization's mail (from SES notifications).
  const blocked = await eventsDb.suppressedFor(env.DB, mailbox.organization_id, recipients)
  if (blocked.length) {
    const list = blocked.map((b) => `${b.address} (${b.reason === 'bounce' ? 'address does not exist' : 'marked your mail as spam'})`)
    throw new EmailError('recipient_suppressed', `Not sending to ${list.join(', ')}. Remove them and try again.`, 409)
  }

  // The same file rules as an upload in the app: a blocked type stops the send, and so does too much in total.
  let total = 0
  for (const part of fileParts(parsed.parts)) {
    const bytes = decodePart(raw.subarray(part.start, part.start + part.length), part.encoding)
    total += bytes.length
    if (total > MAX_ATTACHMENTS_BYTES) {
      throw new EmailError('attachments_too_large', `Attachments can add up to at most ${MAX_ATTACHMENTS_BYTES / 1024 / 1024} MB`, 413)
    }
    const name = partName(part) ?? 'attachment'
    const safety = await safetyOf(bytes, name)
    if (safety.level === 'blocked') throw new EmailError('attachment_blocked', `${name}: ${safety.message}`, 403)
  }

  // Who gets it as what, for SES and the delivery log: named in To or Cc, otherwise a Bcc.
  const toSet = new Set(parsed.to.map((a) => lower(a.email)))
  const ccSet = new Set(parsed.cc.map((a) => lower(a.email)))
  const to = recipients.filter((r) => toSet.has(r))
  const cc = recipients.filter((r) => !toSet.has(r) && ccSet.has(r))
  const bcc = recipients.filter((r) => !toSet.has(r) && !ccSet.has(r))

  // Last check before anything leaves: suspension, the hourly and daily caps, and the plan's emails a month.
  const reservation = await reserveSend(env, mailbox, recipients)

  // The copy that leaves: no Bcc line, and the Date and Message-ID a careless client left out.
  const domain = from.slice(from.lastIndexOf('@') + 1)
  const missing = [
    ...(hasHeader(raw, 'date') ? [] : [`Date: ${rfc5322Date(new Date())}`]),
    ...(hasHeader(raw, 'message-id') ? [] : [`Message-ID: <${ulid()}@${domain}>`]),
  ]
  raw = rewriteHeaders(raw, ['bcc'], missing)
  const size = raw.length
  let sesId: string
  try {
    sesId = await sendRaw(env, { from, to, cc, bcc, raw })
  } catch (err) {
    await reservation.release()
    throw err
  }

  // The Sent copy: SES's Message-ID in place of the client's (SES replaces it on the way out, so replies carry SES's),
  // and a Bcc line, which the leaving copy can't have.
  const id = ulid()
  const messageId = sesMessageId(env, sesId)
  raw = rewriteHeaders(raw, ['message-id'], [`Message-ID: <${messageId}>`, ...(bcc.length ? [`Bcc: ${bcc.join(', ')}`] : [])])
  const bucket = await organizationBucket(env, mailbox.organization_id)
  const key = rawKey(mailbox.id, id)
  await putObject(env, bucket, key, raw, { contentType: 'message/rfc822', metadata: { 'email-id': id, 'ses-id': sesId } })
  const files = fileParts(locateParts(raw))
  const stub = await store(env, mailbox.id)
  await stub.deliver({
    id,
    sesId,
    messageId,
    inReplyTo: messageIds(parsed.inReplyTo)[0] ?? null,
    references: messageIds(parsed.references),
    subject: parsed.subject,
    from: parsed.from,
    to: parsed.to,
    cc: parsed.cc,
    bcc: bcc.map((email) => ({ name: null, email })),
    own,
    preview: previewOf(parsed.text),
    text: parsed.text,
    receivedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    size: raw.length,
    hasAttachment: files.some((p) => p.disposition !== 'inline' || !p.contentId),
    rawKey: key,
    attachments: files.map((p) => ({
      name: partName(p),
      type: p.type,
      size: decodePart(raw!.subarray(p.start, p.start + p.length), p.encoding).length,
      start: p.start,
      length: p.length,
      encoding: p.encoding,
    })),
    junk: false,
    folder: 'sent',
    seen: true,
    verdicts: {},
  })
  raw = null
  await queueMailEvent(env, { kind: 'new', mailboxId: mailbox.id, ids: [id], direction: 'out' })
  // One line per recipient, like the receiving server's answers (jobs/ses-webhook.ts), so each can be looked up.
  const lines = [...to.map((address) => ({ address, as: 'to' })), ...cc.map((address) => ({ address, as: 'cc' })), ...bcc.map((address) => ({ address, as: 'bcc' }))]
  await stub.logDelivery(
    lines.map((r) => ({ step: 'sent' as const, emailId: id, sesId, address: r.address, detail: { as: r.as, recipients: lines.length, size, smtp: true } })),
  )
  const userIds = (await accessDb.listToNotify(env.DB, mailbox.id)).map((a) => a.user_id)
  if (userIds.length) await announce(env, mailbox.organization_id, { type: 'mail', mailboxId: mailbox.id }, userIds)
  return { id, sesId }
}
