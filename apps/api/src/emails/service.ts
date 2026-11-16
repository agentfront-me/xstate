// POST /v1/emails and the send log behind GET /v1/emails (docs/transactional-api-plan.md): how a server sends mail
// from a mailbox with a personal API token (auth/api-tokens.ts).
//
// A message sent here is an ordinary message from that mailbox. It goes through the same sendMessage as mail written
// in the app, so the suppression list, the sending caps and suspension (mailserver/sending.ts) and the attachment
// rules all apply unchanged, and its bounces and complaints count against the mailbox like any other mail.
//
// What is different:
// - `from` may be an alias of the mailbox, with any display name.
// - Recipients on the suppression list are skipped and reported, instead of failing the whole message.
// - Nothing is left in the mailbox unless the request says saveToSent.
// - Every message is logged (api_emails) with a status per recipient, which the SES webhook keeps up to date
//   (recordDeliveryEvent). Bodies and attachments are not kept.
// - An Idempotency-Key makes a retry safe: the same key and body return the first answer instead of sending again.

import type { TokenAuth } from '../auth/api-tokens'
import * as addressesDb from '../db/addresses'
import * as db from '../db/api-emails'
import type { ApiEmailRow, RecipientRow } from '../db/api-emails'
import * as eventsDb from '../db/email-events'
import { ApiError } from '../errors'
import { sendMessage, uploadAttachment } from '../mailserver'
import { htmlToText } from '../mailserver/messages'
import { outsideAddresses } from '../mailserver/sending'
import {
  IDEMPOTENCY_HOURS,
  LOG_DAYS,
  MAX_ATTACHMENTS_BYTES,
  base64Bytes,
  decodeBase64,
  newEmailId,
  nextStatus,
  overallStatus,
  requestHash,
  retryAfterSeconds,
  type EmailStatus,
  type RecipientStatus,
  type SendInput,
} from './rules.ts'

export type ApiEmail = {
  id: string
  status: EmailStatus
  from: { email: string; name: string | null }
  subject: string
  recipients: { email: string; type: 'to' | 'cc' | 'bcc'; status: RecipientStatus; detail: string | null; updatedAt: string }[]
  savedToSent: boolean
  tags: Record<string, string>
  createdAt: string
}

const HOUR = 60 * 60 * 1000

function present(row: ApiEmailRow): ApiEmail {
  const recipients = JSON.parse(row.recipients) as RecipientRow[]
  return {
    id: row.id,
    status: overallStatus(recipients.map((r) => r.status)),
    from: { email: row.from_email, name: row.from_name },
    subject: row.subject,
    recipients: recipients.map((r) => ({ email: r.address, type: r.type, status: r.status, detail: r.detail, updatedAt: r.updated_at })),
    savedToSent: !!row.saved_to_sent,
    tags: JSON.parse(row.tags) as Record<string, string>,
    createdAt: row.created_at,
  }
}

function requireScope(auth: TokenAuth): void {
  if (!auth.token.scopes.includes('mail.send')) throw new ApiError('forbidden', 'This token can’t send email', 403)
}

/** The mailbox that owns `from`, if the token may send from it. One answer for every reason it may not. */
async function senderMailbox(env: Env, auth: TokenAuth, from: string): Promise<string> {
  const owner = await addressesDb.findByAddress(env.DB, from)
  if (!owner || owner.organization_id !== auth.token.organizationId || !auth.actor.mailboxIds?.includes(owner.mailbox_id)) {
    throw new ApiError('from_not_allowed', `This token can’t send from ${from}. Use an address of a mailbox the token was given.`, 403)
  }
  return owner.mailbox_id
}

/**
 * What an earlier request with this Idempotency-Key did: its message to return again, or nothing if the key is new
 * (or older than 24 hours, when it is free to use again).
 */
async function replay(env: Env, tokenId: string, key: string, hash: string): Promise<ApiEmail | null> {
  const row = await db.findByIdempotencyKey(env.DB, tokenId, key)
  if (!row) return null
  if (Date.parse(row.created_at) < Date.now() - IDEMPOTENCY_HOURS * HOUR) {
    await db.forgetIdempotencyKey(env.DB, row.id)
    return null
  }
  if (row.request_hash !== hash) {
    throw new ApiError('idempotency_conflict', 'This Idempotency-Key was already used for a different message. Use a new key for a new message.', 409)
  }
  const email = present(row)
  // Still being sent by the first request: answering now could tell the caller "queued" for a message that then fails.
  if (email.status === 'queued' && Date.parse(row.created_at) > Date.now() - 2 * 60 * 1000) {
    throw new ApiError('request_in_progress', 'A request with this Idempotency-Key is still being sent. Try again in a few seconds.', 409)
  }
  return email
}

/** Sends a message. `replayed` is true when an earlier request with the same Idempotency-Key already sent it. */
export async function sendEmail(env: Env, auth: TokenAuth, input: SendInput, idempotencyKey: string | null): Promise<{ email: ApiEmail; replayed: boolean }> {
  requireScope(auth)
  const mailboxId = await senderMailbox(env, auth, input.from.email)

  const hash = idempotencyKey ? await requestHash(input) : null
  if (idempotencyKey) {
    const earlier = await replay(env, auth.token.id, idempotencyKey, hash!)
    if (earlier) return { email: earlier, replayed: true }
  }

  const listed = [
    ...input.to.map((r) => ({ ...r, type: 'to' as const })),
    ...(input.cc ?? []).map((r) => ({ ...r, type: 'cc' as const })),
    ...(input.bcc ?? []).map((r) => ({ ...r, type: 'bcc' as const })),
  ]
  // Addresses that bounced before, or complained about this organization's mail: skipped, and reported as such.
  const suppressed = new Map(
    (await eventsDb.suppressedFor(env.DB, auth.token.organizationId, listed.map((r) => r.email))).map((s) => [s.address, s.reason]),
  )
  const sendTo = listed.filter((r) => !suppressed.has(r.email))
  if (!sendTo.length) {
    throw new ApiError('all_recipients_suppressed', 'Not sent: every recipient either bounced before or marked your mail as spam.', 422, {
      recipients: listed.map((r) => ({ email: r.email, reason: suppressed.get(r.email) })),
    })
  }
  if (!sendTo.some((r) => r.type === 'to')) {
    throw new ApiError('all_recipients_suppressed', 'Not sent: every address in "to" either bounced before or marked your mail as spam.', 422, {
      recipients: listed.filter((r) => suppressed.has(r.email)).map((r) => ({ email: r.email, reason: suppressed.get(r.email) })),
    })
  }

  // Sizes first, from the lengths alone, so an oversized request is refused before anything is decoded or uploaded.
  const files = input.attachments ?? []
  if (files.reduce((sum, f) => sum + base64Bytes(f.content), 0) > MAX_ATTACHMENTS_BYTES + 1024) throw tooLarge()
  const decoded = files.map((f) => {
    const bytes = decodeBase64(f.content)
    if (!bytes?.byteLength) throw new ApiError('invalid_input', `The content of ${f.name} is not base64`)
    return { ...f, bytes }
  })
  if (decoded.reduce((sum, f) => sum + f.bytes.byteLength, 0) > MAX_ATTACHMENTS_BYTES) throw tooLarge()

  const id = newEmailId()
  const now = new Date().toISOString()
  const messageId = `${id}@${input.from.email.slice(input.from.email.lastIndexOf('@') + 1)}`
  try {
    await db.insert(env.DB, {
      id,
      organizationId: auth.token.organizationId,
      mailboxId,
      tokenId: auth.token.id,
      userId: auth.token.userId,
      from: input.from,
      subject: input.subject,
      tags: input.tags ?? {},
      savedToSent: input.saveToSent,
      messageId,
      idempotencyKey,
      requestHash: hash,
      recipients: listed.map((r) => {
        const reason = suppressed.get(r.email)
        return {
          address: r.email,
          type: r.type,
          status: reason ? ('suppressed' as const) : ('queued' as const),
          detail: reason ? (reason === 'bounce' ? 'This address bounced before' : 'This address marked your mail as spam') : null,
        }
      }),
      now,
    })
  } catch (err) {
    // Two requests with the same new key at the same moment: the unique index let one through, and this is the other.
    const earlier = idempotencyKey ? await replay(env, auth.token.id, idempotencyKey, hash!) : null
    if (earlier) return { email: earlier, replayed: true }
    throw err
  }

  try {
    // Each file goes through the same checks as an attachment uploaded in the app: file-type rules and the virus scan.
    const attachments: { blobId: string; name: string; type: string }[] = []
    const inline: Record<string, string> = {}
    for (const f of decoded) {
      const blob = await uploadAttachment(env, auth.actor, mailboxId, new Response(f.bytes).body!, { name: f.name, contentType: f.type, size: f.bytes.byteLength })
      attachments.push({ blobId: blob.blobId, name: f.name, type: f.type })
      if (f.contentId) inline[f.contentId] = blob.blobId
    }
    const pick = (type: 'to' | 'cc' | 'bcc') => sendTo.filter((r) => r.type === type).map((r) => ({ email: r.email, name: r.name }))
    await sendMessage(env, auth.actor, mailboxId, {
      to: pick('to'),
      cc: pick('cc'),
      bcc: pick('bcc'),
      subject: input.subject,
      text: input.text || htmlToText(input.html ?? ''),
      html: input.html,
      attachments,
      api: { from: input.from, replyTo: input.replyTo, headers: input.headers, messageId, keepCopy: input.saveToSent, inline },
    })
  } catch (err) {
    await db.remove(env.DB, id).catch((e) => console.error('emails: removing the unsent log row failed', e))
    if (err instanceof ApiError && err.code === 'send_limit_reached') {
      throw new ApiError(err.code, err.message, 429, { retryAfter: retryAfterSeconds(err.message) })
    }
    throw err
  }

  // Mail to an address on xstate is delivered by the mail server at once, and Amazon SES never reports on it.
  const addresses = sendTo.map((r) => r.email)
  const outside = new Set(await outsideAddresses(env.DB, addresses))
  await db.markSent(env.DB, id, addresses.filter((a) => !outside.has(a)), new Date().toISOString())
  console.log('api email sent', JSON.stringify({ id, tokenId: auth.token.id, mailboxId, recipients: sendTo.length, suppressed: suppressed.size, saved: input.saveToSent }))
  return { email: present((await db.find(env.DB, id))!), replayed: false }
}

const tooLarge = () =>
  new ApiError('attachments_too_large', `Attachments can be at most ${MAX_ATTACHMENTS_BYTES / 1024 / 1024} MB in total`, 413)

/** A message the token's owner sent through the API, from a mailbox the token can still use. */
export async function getEmail(env: Env, auth: TokenAuth, id: string): Promise<{ email: ApiEmail }> {
  requireScope(auth)
  const row = await db.find(env.DB, id)
  const visible =
    row && row.organization_id === auth.token.organizationId && row.user_id === auth.token.userId && !!row.mailbox_id && auth.actor.mailboxIds?.includes(row.mailbox_id)
  // Same answer for one that doesn't exist and one this token may not see.
  if (!visible) throw new ApiError('email_not_found', 'Email not found', 404)
  return { email: present(row) }
}

export type ListQuery = { limit: number; cursor?: string; status?: RecipientStatus; from?: string; tags: Record<string, string> }

const encodeCursor = (row: ApiEmailRow) => btoa(`${row.created_at}|${row.id}`)
function decodeCursor(cursor: string): { createdAt: string; id: string } {
  try {
    const [createdAt, id] = atob(cursor).split('|')
    if (createdAt && id && !Number.isNaN(Date.parse(createdAt))) return { createdAt, id }
  } catch {
    // Fall through to the error below.
  }
  throw new ApiError('invalid_input', 'That cursor is not one this API returned')
}

/** The send log, newest first: what the token's owner sent through the API from mailboxes the token can still use. */
export async function listEmails(env: Env, auth: TokenAuth, query: ListQuery): Promise<{ emails: ApiEmail[]; nextCursor: string | null }> {
  requireScope(auth)
  const rows = await db.list(env.DB, {
    organizationId: auth.token.organizationId,
    userId: auth.token.userId,
    mailboxIds: auth.actor.mailboxIds ?? [],
    limit: query.limit,
    after: query.cursor ? decodeCursor(query.cursor) : undefined,
    status: query.status,
    from: query.from,
    tags: query.tags,
  })
  const page = rows.slice(0, query.limit)
  return { emails: page.map(present), nextCursor: rows.length > query.limit ? encodeCursor(page[page.length - 1]!) : null }
}

// ---------------------------------------------------------------------------------------------------------------
// Delivery events and upkeep

/**
 * Updates the send log from an Amazon SES event (jobs/ses-webhook.ts). Mail that wasn't sent through the API has no
 * row and is left alone. SES only echoes our Message-ID when its notifications include the original headers, so
 * without it the newest message from that sender to that address in the last 3 days is taken.
 */
export async function recordDeliveryEvent(
  env: Pick<Env, 'DB'>,
  event: { kind: 'delivered' | 'bounced' | 'complained'; sender: string; recipient: string; messageId: string | null; detail: string | null },
): Promise<void> {
  const row = await db.findRecipientForEvent(env.DB, {
    messageId: event.messageId,
    sender: event.sender.toLowerCase(),
    recipient: event.recipient.toLowerCase(),
    since: new Date(Date.now() - 3 * 24 * HOUR).toISOString(),
  })
  if (!row) return
  const status = nextStatus(row.status, event.kind)
  if (status === row.status) return
  await db.setRecipientStatus(env.DB, { emailId: row.email_id, address: row.address, status, detail: event.detail, now: new Date().toISOString() })
}

/** Hourly: removes messages from the send log once they are 30 days old. */
export async function emailsHourly(env: Pick<Env, 'DB'>): Promise<void> {
  const purged = await db.purge(env.DB, new Date(Date.now() - LOG_DAYS * 24 * HOUR).toISOString())
  if (purged) console.log('api emails purged', purged)
}
