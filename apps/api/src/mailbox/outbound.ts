// Sending, drafts and attachment uploads for mailboxes whose mail the store holds (docs/mailbox-store-plan.md,
// phase 2 step 3). mailserver/messages.ts makes the checks every message passes (checkOutgoing, reserveSend) and
// hands store-held mailboxes here: the message is built (./compose.ts), sent through SES (./ses-send.ts), and its
// Sent copy, or the draft, kept in R2 and the mailbox's store. Nothing goes through Stalwart.

import type { MailboxRow } from '../db/mailboxes'
import { announce } from '../live/announce'
import * as accessDb from '../db/mailbox-access'
import { EmailError } from '../mailserver/errors'
import { MAX_ATTACHMENTS_BYTES, type SendInput } from '../mailserver/messages'
import { reserveSend } from '../mailserver/sending'
import type { EmailEnv } from '../mailserver/types'
import { checkName, inspectStream, type Safety } from '../security/attachments'
import { organizationBucket } from '../storage/buckets'
import { deleteObject, getObject, putObject } from '../storage/r2'
import { addressList, buildMessage, type OutFile, type OutMessage } from './compose'
import { previewOf, ulid } from './inbound'
import { decodePart, type PartEncoding } from './mime'
import { fileParts } from './parse'
import { parseStoreBlobId, storeBlob, storeBlobId } from './read'
import { sendRaw, sesMessageId, type SendEnv } from './ses-send'
import { rawKey } from './shadow'
import { locateParts } from './mime'
import type { StoreDelivery } from './store'
import { store } from './stub'

export type OutboundEnv = EmailEnv & SendEnv

/** What checkOutgoing (mailserver/messages.ts) settled: recipients and the From address and name. */
export type Checked = { recipients: { name?: string | null; email: string }[]; fromEmail: string; fromName: string | null }

/** An attachment upload kept for a message about to be written: `<mailboxId>/uploads/<ULID>`, id `upload.<ULID>`. */
const uploadKey = (mailboxId: string, id: string) => `${mailboxId}/uploads/${id}`
export const parseUploadId = (blobId: string) => /^upload\.([0-9A-HJKMNP-TV-Z]{26})$/.exec(blobId)?.[1] ?? null

/** Keeps an uploaded attachment (already checked and scanned) until it is sent; returns its id. */
export async function uploadToStore(env: OutboundEnv, mailbox: MailboxRow, bytes: Uint8Array, contentType: string): Promise<string> {
  const id = ulid()
  const bucket = await organizationBucket(env, mailbox.organization_id)
  await putObject(env, bucket, uploadKey(mailbox.id, id), bytes, { contentType: contentType || 'application/octet-stream' })
  return `upload.${id}`
}

/** Sends a message from a store-held mailbox. Returns the Sent copy's id and conversation (empty when not kept). */
export async function sendFromStore(env: OutboundEnv, mailbox: MailboxRow, input: SendInput, checked: Checked): Promise<{ id: string; threadId: string }> {
  const prepared = await prepare(env, mailbox, input, checked)
  const { message, bucket } = prepared
  // Last check before anything leaves: suspension and the hourly and daily caps.
  const reservation = await reserveSend(env, mailbox, checked.recipients.map((r) => r.email))
  let raw: Uint8Array | null = buildMessage(message, { includeBcc: false })
  // The files are inside the message now; drop them so a large send keeps one copy in memory.
  message.files = undefined
  let sesId: string
  try {
    sesId = await sendRaw(env, {
      from: checked.fromEmail,
      to: input.to.map((a) => a.email),
      cc: (input.cc ?? []).map((a) => a.email),
      bcc: (input.bcc ?? []).map((a) => a.email),
      raw,
    })
  } catch (err) {
    await reservation.release()
    throw err
  }

  const stub = await store(env, mailbox.id)
  let kept = { id: '', threadId: '' }
  if (input.api?.keepCopy !== false) {
    // SES replaced our Message-ID with its own; the Sent copy carries SES's, so replies to it match, plus the Bcc.
    const copy = sentCopy(raw, message.messageId, sesMessageId(env, sesId), message.bcc ?? [])
    raw = null
    const id = ulid()
    await putObject(env, bucket, rawKey(mailbox.id, id), copy, { contentType: 'message/rfc822', metadata: { 'email-id': id, 'ses-id': sesId } })
    const stored = await stub.deliver(own(prepared, { id, raw: copy, sesId, messageId: sesMessageId(env, sesId), folder: 'sent', mailbox, checked }))
    kept = { id, threadId: stored.threadId }
  }
  await afterWriting(env, mailbox, prepared, input)
  if (prepared.original) await stub.markOriginal(prepared.original.id, input.inReplyTo ? 'answered' : 'forwarded')
  return kept
}

/** Saves a draft in a store-held mailbox's Drafts. Nothing is sent. */
export async function draftInStore(env: OutboundEnv, mailbox: MailboxRow, input: SendInput, checked: Checked): Promise<{ id: string; threadId: string }> {
  const prepared = await prepare(env, mailbox, input, checked)
  const raw = buildMessage(prepared.message, { includeBcc: true })
  const id = ulid()
  await putObject(env, prepared.bucket, rawKey(mailbox.id, id), raw, { contentType: 'message/rfc822', metadata: { 'email-id': id } })
  const stored = await (await store(env, mailbox.id)).deliver(own(prepared, { id, raw, sesId: null, messageId: prepared.message.messageId, folder: 'drafts', mailbox, checked }))
  await afterWriting(env, mailbox, prepared, input)
  return { id, threadId: stored.threadId }
}

type Prepared = {
  message: OutMessage
  bucket: string
  original: { id: string } | null
  inReplyTo: string | null
  references: string[]
  hasAttachment: boolean
}

/** The message to build: threading from the original or the draft, and every attachment read and checked. */
async function prepare(env: OutboundEnv, mailbox: MailboxRow, input: SendInput, checked: Checked): Promise<Prepared> {
  const stub = await store(env, mailbox.id)
  const bucket = await organizationBucket(env, mailbox.organization_id)

  const sourceId = input.inReplyTo ?? input.forwardOf
  const original = sourceId ? await stub.replySource(sourceId) : null
  if (sourceId && !original) throw new EmailError('message_not_found', 'The message you are replying to no longer exists', 404)
  let inReplyTo: string | null = null
  let references: string[] = []
  if (input.inReplyTo && original?.messageId) {
    inReplyTo = original.messageId
    references = [...original.references, original.messageId]
  }
  if (input.draftId) {
    const draft = await stub.draft(input.draftId)
    if (!draft) throw new EmailError('draft_not_found', 'That draft no longer exists. It may have been sent or deleted.', 404)
    if (!inReplyTo && draft.inReplyTo) {
      inReplyTo = draft.inReplyTo
      references = draft.references.length ? draft.references : [draft.inReplyTo]
    }
  }

  // Attachments chosen for the message: uploads, or files of messages in this mailbox. A blocked one fails the send.
  const files: OutFile[] = []
  for (const a of input.attachments ?? []) {
    const bytes = await attachmentBytes(env, mailbox, bucket, a.blobId)
    const safety = await safetyOf(bytes, a.name)
    if (safety.level === 'blocked') throw new EmailError('attachment_blocked', `${a.name}: ${safety.message}`, 403)
    files.push({ name: a.name, type: a.type, bytes })
  }
  // A forward brings the original's files along, except blocked ones and ones already chosen.
  if (input.forwardOf && original?.rawKey && original.attachments.length) {
    const chosen = new Set((input.attachments ?? []).map((a) => a.blobId))
    const res = await getObject(env, bucket, original.rawKey)
    const raw = res ? new Uint8Array(await res.arrayBuffer()) : null
    for (const part of raw ? original.attachments : []) {
      if (chosen.has(storeBlobId(original.id, part.start))) continue
      const bytes = decodePart(raw!.subarray(part.start, part.start + part.length), part.encoding as PartEncoding)
      const name = part.name ?? 'attachment'
      if ((await safetyOf(bytes, name)).level === 'blocked') continue
      files.push({ name, type: part.type, bytes })
    }
  }
  const total = files.reduce((n, f) => n + f.bytes.length, 0)
  if (total > MAX_ATTACHMENTS_BYTES) {
    throw new EmailError(
      'attachments_too_large',
      `Attachments add up to ${(total / 1024 / 1024).toFixed(1)} MB; a message can carry at most ${MAX_ATTACHMENTS_BYTES / 1024 / 1024} MB. ` +
        'Remove some, or share large files from Storage as a link.',
    )
  }
  // Images the HTML shows with cid: (API sends name them by Content-ID).
  const cidOf = new Map(Object.entries(input.api?.inline ?? {}).map(([cid, blobId]) => [blobId, cid]))
  ;(input.attachments ?? []).forEach((a, i) => {
    const cid = cidOf.get(a.blobId)
    if (cid && input.html) files[i]!.cid = cid
  })

  const domain = checked.fromEmail.slice(checked.fromEmail.lastIndexOf('@') + 1)
  const message: OutMessage = {
    from: { name: checked.fromName, email: checked.fromEmail },
    to: input.to.map((a) => ({ name: a.name ?? null, email: a.email })),
    cc: (input.cc ?? []).map((a) => ({ name: a.name ?? null, email: a.email })),
    bcc: (input.bcc ?? []).map((a) => ({ name: a.name ?? null, email: a.email })),
    replyTo: (input.api?.replyTo ?? []).map((a) => ({ name: a.name ?? null, email: a.email })),
    subject: input.subject,
    text: input.text,
    html: input.html ?? null,
    messageId: input.api?.messageId ?? `${ulid()}@${domain}`,
    inReplyTo: inReplyTo ? [inReplyTo] : [],
    references,
    date: new Date(),
    headers: input.api?.headers,
    files,
  }
  return { message, bucket, original, inReplyTo, references, hasAttachment: files.some((f) => !f.cid) }
}

/** The bytes of an attachment chosen by id: an upload, or a file of a message in this mailbox. */
async function attachmentBytes(env: OutboundEnv, mailbox: MailboxRow, bucket: string, blobId: string): Promise<Uint8Array> {
  const upload = parseUploadId(blobId)
  if (upload) {
    const res = await getObject(env, bucket, uploadKey(mailbox.id, upload))
    if (res) return new Uint8Array(await res.arrayBuffer())
  } else if (parseStoreBlobId(blobId)) {
    const blob = await storeBlob(env, mailbox, blobId)
    if (blob) return blob.bytes
  }
  throw new EmailError('attachment_not_found', 'An attachment of this message no longer exists; attach it again', 404)
}

async function safetyOf(bytes: Uint8Array, name: string): Promise<Safety> {
  const byName = checkName(name)
  if (byName.level === 'blocked') return byName
  const { safety, body } = await inspectStream(new Response(bytes).body!, name)
  await body.cancel().catch(() => null)
  return safety
}

/**
 * The Sent copy: the message as it left, with SES's Message-ID in place of ours (SES replaces it) and the Bcc
 * line the leaving copy can't have. Only the header block changes.
 */
function sentCopy(raw: Uint8Array, ourId: string, sesId: string, bcc: { name: string | null; email: string }[]): Uint8Array {
  const enc = new TextEncoder()
  const head = new TextDecoder('latin1').decode(raw.subarray(0, Math.min(raw.length, 64 * 1024)))
  const line = `Message-ID: <${ourId}>\r\n`
  const at = head.indexOf(line)
  if (at < 0) return raw
  const replacement = enc.encode((bcc.length ? `Bcc: ${addressList(bcc)}\r\n` : '') + `Message-ID: <${sesId}>\r\n`)
  const out = new Uint8Array(raw.length - line.length + replacement.length)
  out.set(raw.subarray(0, at), 0)
  out.set(replacement, at)
  out.set(raw.subarray(at + line.length), at + replacement.length)
  return out
}

/** The store row for mail the mailbox wrote: its Sent copy or a draft. */
function own(
  p: Prepared,
  o: { id: string; raw: Uint8Array; sesId: string | null; messageId: string; folder: 'sent' | 'drafts'; mailbox: MailboxRow; checked: Checked },
): StoreDelivery {
  const m = p.message
  const files = fileParts(locateParts(o.raw))
  return {
    id: o.id,
    sesId: o.sesId,
    messageId: o.messageId,
    inReplyTo: p.inReplyTo,
    references: p.references,
    subject: m.subject,
    from: [m.from],
    to: m.to,
    cc: m.cc ?? [],
    own: [o.mailbox.address, ...(JSON.parse(o.mailbox.aliases || '[]') as string[])],
    preview: previewOf(m.text),
    text: m.text,
    receivedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    size: o.raw.length,
    hasAttachment: p.hasAttachment,
    rawKey: rawKey(o.mailbox.id, o.id),
    attachments: files.map((part) => ({
      name: part.name,
      type: part.type,
      size: decodePart(o.raw.subarray(part.start, part.start + part.length), part.encoding).length,
      start: part.start,
      length: part.length,
      encoding: part.encoding,
    })),
    junk: false,
    folder: o.folder,
    seen: true,
    verdicts: {},
  }
}

/** After sending or saving: the draft it replaces goes, and the apps reload the mailbox. */
async function afterWriting(env: OutboundEnv, mailbox: MailboxRow, p: Prepared, input: SendInput): Promise<void> {
  if (input.draftId) {
    const keys = await (await store(env, mailbox.id)).removeDraft(input.draftId)
    for (const key of keys) await deleteObject(env, p.bucket, key).catch((err) => console.error(`drafts: deleting ${key} failed`, err))
  }
  const userIds = (await accessDb.list(env.DB, mailbox.id)).map((a) => a.user_id)
  if (userIds.length) await announce(env, mailbox.organization_id, { type: 'mail', mailboxId: mailbox.id }, userIds)
}
