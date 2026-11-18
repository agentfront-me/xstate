// Reading mail and acting on messages. Access comes from mailContext / readableMailboxes in ./access: personal mail
// only for its owner, shared and agent mailboxes for the people allowed in. Every mailbox's mail is in its own store
// (mailbox/store.ts, docs/mailbox-store-plan.md): lists and changes go there, whole messages are read from the raw
// copies in the organization's bucket (mailbox/read.ts), and sending goes through Amazon SES (mailbox/outbound.ts).

import * as accessDb from '../db/mailbox-access'
import * as eventsDb from '../db/email-events'
import { announce } from '../live/announce'
import type { MailboxRow } from '../db/mailboxes'
import * as usersDb from '../db/users'
import { checkName, inspectStream, type Safety } from '../security/attachments'
import { mailContext, readableMailboxes } from './access'
import { previewText } from './footer'
import { htmlToText } from './html-text'
import { queueMailEvent } from '../mailbox/events'
import { draftInStore, sendFromStore, uploadToStore } from '../mailbox/outbound'
import { parseStoreBlobId, storeBlob, storeThread } from '../mailbox/read'
import { store } from '../mailbox/stub'
import type { StoreFolderRole, StoreListRow } from '../mailbox/query'
import { EmailError } from './errors'
import type { Actor, EmailEnv } from './types'

export type FolderRole = StoreFolderRole

const ROLES: FolderRole[] = ['inbox', 'sent', 'drafts', 'archive', 'junk', 'trash']
export type FolderView = FolderRole | 'pinned'

export type Folder = { id: string; role: FolderRole | null; name: string; unread: number; total: number }
export type MailboxFolders = { mailboxId: string; address: string; kind: MailboxRow['kind']; folders: Folder[] }
export type Address = { name: string | null; email: string }
export type MessageSummary = {
  id: string
  mailboxId: string
  threadId: string
  /** The role of the folder it is in, or null for a folder without a role. */
  folder: FolderRole | null
  from: Address[]
  to: Address[]
  subject: string
  preview: string
  receivedAt: string
  seen: boolean
  pinned: boolean
  hasAttachment: boolean
  size: number
  /** How many messages the conversation has (in any folder). Lists show one row per conversation. */
  threadSize: number
}
export type Attachment = {
  blobId: string
  name: string
  type: string
  size: number
  inline: boolean
  /** Content-ID, for inline images referenced as cid: in the HTML. */
  cid: string | null
  /**
   * What the file-type rules say about its name (security/attachments). Downloads also check the bytes, so a
   * file can still turn out blocked or get a warning when it's downloaded.
   */
  safety: Safety
}
export type Message = MessageSummary & {
  cc: Address[]
  /** Only ever set on mail you wrote (a draft or a sent message). */
  bcc: Address[]
  replyTo: Address[]
  sentAt: string | null
  messageId: string | null
  text: string
  html: string | null
  attachments: Attachment[]
}

// ---------------------------------------------------------------------------------------------------------------
// Folders

export async function listFolders(
  env: EmailEnv,
  actor: Actor,
  organizationId: string,
  mailboxId?: string,
): Promise<MailboxFolders[]> {
  const mailboxes = await mailboxesFor(env, actor, organizationId, mailboxId)
  const lists = await Promise.all(mailboxes.map(async (m) => (await store(env, m.id)).folderList()))
  return mailboxes.map((m, i) => ({
    mailboxId: m.id,
    address: m.address,
    kind: m.kind,
    folders: lists[i]!.map((f) => ({
      id: f.id,
      role: ROLES.includes(f.role as FolderRole) ? (f.role as FolderRole) : null,
      name: f.name,
      unread: f.unread,
      total: f.total,
    })),
  }))
}

// ---------------------------------------------------------------------------------------------------------------
// Messages

export type ListMessagesInput = {
  /** One mailbox, or omit to merge every mailbox the actor can read ("All inboxes"). */
  mailboxId?: string
  /** A folder, or 'all': every folder but junk and trash. */
  folder: FolderView | 'all'
  unreadOnly?: boolean
  query?: string
  /** Header filters: the From, To or Subject header contains this text (an address, a domain or a name). */
  from?: string
  to?: string
  subject?: string
  /** Received at or after `after`, and strictly before `before`. */
  after?: string
  before?: string
  hasAttachment?: boolean
  /** Fewer fields and a shorter preview, for agents reading many rows. */
  compact?: boolean
  /** `nextCursor` from the previous page. */
  cursor?: string
  limit: number
}

/** A row of a compact list: what's needed to pick a message and open it with email_get_thread. */
export type CompactSummary = Pick<
  MessageSummary,
  'id' | 'mailboxId' | 'threadId' | 'folder' | 'subject' | 'preview' | 'receivedAt' | 'hasAttachment' | 'threadSize'
> & { from: string }

/** Preview lengths. */
const PREVIEW_MAX = 256
const COMPACT_PREVIEW_MAX = 140

/**
 * The newest conversations in a folder across one or all readable mailboxes, one row per conversation: its newest
 * message in that folder, with threadSize; email_get_thread has the rest. Paging uses the receivedAt of the last
 * row as the cursor, so a long conversation can show up again on a later page by an older message (callers drop
 * threadIds they already have); mail that arrived in the same second as a page boundary can be skipped, which is
 * rare.
 */
export async function listMessages(
  env: EmailEnv,
  actor: Actor,
  organizationId: string,
  input: ListMessagesInput,
): Promise<{ messages: (MessageSummary | CompactSummary)[]; nextCursor: string | null }> {
  const mailboxes = await mailboxesFor(env, actor, organizationId, input.mailboxId)
  const text = (v: string | undefined) => v?.trim() || undefined
  const pages = await Promise.all(
    mailboxes.map(async (m) => {
      const page = await (await store(env, m.id)).list({
        folder: input.folder,
        unreadOnly: input.unreadOnly,
        text: text(input.query),
        from: text(input.from),
        to: text(input.to),
        subject: text(input.subject),
        after: input.after,
        before: earliest(input.cursor, input.before),
        hasAttachment: input.hasAttachment,
        limit: input.limit,
      })
      return { more: page.more, messages: page.messages.map((row) => fromStore(row, m.id)) }
    }),
  )
  const all = pages.flatMap((p) => p.messages)
  all.sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt))
  const page = all.slice(0, input.limit)
  const more = all.length > input.limit || pages.some((p) => p.more)
  const nextCursor = more && page.length ? page[page.length - 1]!.receivedAt : null
  return { messages: input.compact ? page.map(compactSummary) : page, nextCursor }
}

/** A row from a mailbox's store as the summary the API returns. */
function fromStore(row: StoreListRow, mailboxId: string): MessageSummary {
  return { ...row, mailboxId, preview: previewText(row.preview, PREVIEW_MAX) }
}

/** The earlier of two times, either of which may be missing. */
function earliest(a: string | undefined, b: string | undefined): string | undefined {
  if (!a || !b) return a ?? b
  return Date.parse(a) <= Date.parse(b) ? a : b
}

function compactSummary(m: MessageSummary): CompactSummary {
  const sender = m.from[0]
  return {
    id: m.id,
    mailboxId: m.mailboxId,
    threadId: m.threadId,
    folder: m.folder,
    from: sender ? (sender.name ? `${sender.name} <${sender.email}>` : sender.email) : '',
    subject: m.subject,
    preview: previewText(m.preview, COMPACT_PREVIEW_MAX),
    receivedAt: m.receivedAt,
    hasAttachment: m.hasAttachment,
    threadSize: m.threadSize,
  }
}

/**
 * The newest messages to or from an address in every mailbox the actor can read (not junk or trash), newest first.
 * For a person's activity in the Users section: someone else's personal mail stays out, as everywhere else.
 */
export async function messagesWith(
  env: EmailEnv,
  actor: Actor,
  organizationId: string,
  address: string,
  limit: number,
): Promise<MessageSummary[]> {
  const mailboxes = await readableMailboxes(env, actor, organizationId)
  if (!mailboxes.length) return []
  // From them or to them: two lists per mailbox, merged. Folder 'all' leaves out junk and trash.
  const found = await Promise.all(
    mailboxes.flatMap((m) =>
      (['from', 'to'] as const).map(async (side) => {
        const page = await (await store(env, m.id)).list({ folder: 'all', [side]: address, limit })
        return page.messages.map((row) => fromStore(row, m.id))
      }),
    ),
  )
  const unique = new Map(found.flat().map((msg) => [`${msg.mailboxId}:${msg.id}`, msg]))
  return [...unique.values()].sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt)).slice(0, limit)
}

/** Every message in a conversation, oldest first, with bodies and attachments. Doesn't mark anything read. */
export async function getThread(env: EmailEnv, actor: Actor, mailboxId: string, threadId: string): Promise<Message[]> {
  const { mailbox } = await mailContext(env, actor, mailboxId, 'read')
  return (await storeThread(env, mailbox, threadId, (row) => fromStore(row, mailbox.id))) ?? []
}

export type UpdateMessageInput = {
  seen?: boolean
  pinned?: boolean
  folder?: FolderRole
  /** Apply seen and folder to the whole conversation (folder: only its messages in this message's folder). */
  thread?: boolean
}

/** Marks a message read or unread, pins or unpins it, or moves it to another folder (archive, junk, trash, inbox). */
export async function updateMessage(
  env: EmailEnv,
  actor: Actor,
  mailboxId: string,
  messageId: string,
  input: UpdateMessageInput,
): Promise<void> {
  const { mailbox } = await mailContext(env, actor, mailboxId, 'write')
  // The change is made in the mailbox's store (mailbox/store.ts update), then announced.
  const result = await (await store(env, mailbox.id)).update({ id: messageId, ...input })
  if (!result.found) throw new EmailError('message_not_found', 'Message not found', 404)
  if (result.moved) await queueMailEvent(env, { kind: 'moved', mailboxId: mailbox.id, ids: result.changedIds })
  if (result.changed) await announceMailChange(env, mailbox)
}

/** Tells the people who can open the mailbox that its mail changed, so the apps reload it. Never fails the caller. */
async function announceMailChange(env: EmailEnv, mailbox: MailboxRow): Promise<void> {
  const userIds = (await accessDb.listToNotify(env.DB, mailbox.id)).map((a) => a.user_id)
  if (userIds.length) await announce(env, mailbox.organization_id, { type: 'mail', mailboxId: mailbox.id }, userIds)
}

/**
 * An opaque token that changes whenever mail changes in any mailbox the actor can read. The dashboard polls it
 * and reloads when it differs.
 */
export async function getMailState(env: EmailEnv, actor: Actor, organizationId: string): Promise<string> {
  const mailboxes = await readableMailboxes(env, actor, organizationId)
  const states = await Promise.all(mailboxes.map(async (m) => (await store(env, m.id)).changeState()))
  return mailboxes.map((m, i) => `${m.id}:s${states[i] ?? ''}`).join(',')
}

/** An attachment's bytes, as a download. */
export async function getAttachment(
  env: EmailEnv,
  actor: Actor,
  mailboxId: string,
  blobId: string,
  name: string,
  type: string,
): Promise<Response> {
  const { mailbox } = await mailContext(env, actor, mailboxId, 'read')
  // Read back from the message's raw copy in the organization's bucket.
  const blob = parseStoreBlobId(blobId) ? await storeBlob(env, mailbox, blobId) : null
  if (!blob) throw new EmailError('attachment_not_found', 'That attachment no longer exists', 404)
  const upstream = new Response(blob.bytes, { headers: { 'Content-Type': type || blob.type, 'Content-Length': String(blob.bytes.byteLength) } })
  // File-type rules: blocked files never leave; warnings travel in a header the apps show before saving.
  const { safety, body } = await inspectStream(upstream.body!, name)
  if (safety.level === 'blocked') {
    await body.cancel().catch(() => null)
    throw blockedAttachment(name, safety)
  }
  const headers = new Headers({
    'Content-Type': upstream.headers.get('Content-Type') ?? type,
    // Always a download, never rendered: attachments are untrusted content.
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, max-age=300',
  })
  if (safety.level === 'warn') headers.set('X-Attachment-Warning', safety.code!)
  const length = upstream.headers.get('Content-Length')
  if (length) headers.set('Content-Length', length)
  return new Response(body, { headers })
}

const blockedAttachment = (name: string, safety: Safety) =>
  new EmailError('attachment_blocked', `${name}: ${safety.message}`, 403)

// ---------------------------------------------------------------------------------------------------------------

async function mailboxesFor(env: EmailEnv, actor: Actor, organizationId: string, mailboxId?: string): Promise<MailboxRow[]> {
  if (!mailboxId) return readableMailboxes(env, actor, organizationId)
  const { mailbox } = await mailContext(env, actor, mailboxId, 'read')
  if (mailbox.organization_id !== organizationId) throw new EmailError('mailbox_not_found', 'Mailbox not found', 404)
  return [mailbox]
}

/** Readable plain text from HTML, for messages sent without a text part. Agents, previews and search read this. */
export { htmlToText }

// ---------------------------------------------------------------------------------------------------------------
// Sending

/** At most this many To + Cc + Bcc recipients per message. Bulk mail isn't what xstate is for. */
export const MAX_RECIPIENTS = 50
/** Largest attachment upload, matching what most mail servers accept for a whole message. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024
/**
 * Largest total of a message's attachments (sent or draft), uploads and forwarded ones together. Outgoing mail goes through
 * Amazon SES, which refuses messages over 40 MB once encoded, and attachments grow by about a third when encoded;
 * past that the send would be accepted here and bounce later. 25 MB is also what Gmail allows.
 */
export const MAX_ATTACHMENTS_BYTES = 25 * 1024 * 1024

export type SendInput = {
  to: Address[]
  cc?: Address[]
  bcc?: Address[]
  subject: string
  text: string
  html?: string
  /** Message being replied to: sets In-Reply-To and References, so mail apps thread it, and marks it $answered. */
  inReplyTo?: string
  /** Message being forwarded: its attachments come along, and it's marked $forwarded. */
  forwardOf?: string
  /** Files from email_upload_attachment, plus (for a forward) any of the original's attachments to keep. */
  attachments?: { blobId: string; name: string; type: string }[]
  /**
   * A draft in this mailbox's Drafts that this message finishes: sending it, or saving a new version of it. The
   * draft's threading headers carry over when no inReplyTo is given, and the draft is deleted once the new
   * message exists. Its attachments are not taken along; pass the ones to keep in attachments.
   */
  draftId?: string
  /** Only set for mail sent through the API (emails/service.ts). */
  api?: ApiSendOptions
}

/**
 * What a message sent through POST /v1/emails may set that one written in the app can't. The caller has already
 * checked the token and the size of the request; compose still checks the sender address against the mailbox.
 */
export type ApiSendOptions = {
  /** The mailbox's primary address or one of its aliases, with the name to show. */
  from: { email: string; name: string | null }
  replyTo?: Address[]
  /** Extra headers, already limited to the allowed names and checked for line breaks. */
  headers?: Record<string, string>
  /** The Message-ID to send with, without angle brackets, so delivery events can be matched to the message. */
  messageId: string
  /** false leaves nothing in the mailbox: the message is deleted once it is on its way. */
  keepCopy: boolean
  /** Blob ids of attachments shown inside the HTML (cid:), by Content-ID. */
  inline?: Record<string, string>
}

/** Sends a message from the mailbox's primary address (or, through the API, one of its aliases), through Amazon SES. */
export async function sendMessage(
  env: EmailEnv,
  actor: Actor,
  mailboxId: string,
  input: SendInput,
): Promise<{ id: string; threadId: string }> {
  const { mailbox } = await mailContext(env, actor, mailboxId, 'write')
  return sendFromStore(env, mailbox, input, await checkOutgoing(env, actor, mailbox, input, true))
}

/**
 * Saves a message to the mailbox's Drafts without sending it (agents use this so a person can review and send).
 * Same addressing, threading and attachments as sendMessage; no sending caps, since nothing leaves.
 */
export async function saveDraft(
  env: EmailEnv,
  actor: Actor,
  mailboxId: string,
  input: SendInput,
): Promise<{ id: string; threadId: string }> {
  const { mailbox } = await mailContext(env, actor, mailboxId, 'write')
  return draftInStore(env, mailbox, input, await checkOutgoing(env, actor, mailbox, input, false))
}

/**
 * The checks every outgoing message passes: recipients (count, suppression) and
 * the From address and name. Returns what the message is built with.
 */
export async function checkOutgoing(env: EmailEnv, actor: Actor, mailbox: MailboxRow, input: SendInput, sending: boolean) {
  const recipients = [...input.to, ...(input.cc ?? []), ...(input.bcc ?? [])]
  if (sending && !recipients.length) throw new EmailError('no_recipients', 'Add at least one recipient')
  if (recipients.length > MAX_RECIPIENTS) {
    throw new EmailError('too_many_recipients', `A message can have at most ${MAX_RECIPIENTS} recipients`)
  }

  // Addresses that hard-bounced before, or complained about this organization's mail (from SES notifications).
  const blocked = await eventsDb.suppressedFor(env.DB, mailbox.organization_id, recipients.map((r) => r.email))
  if (blocked.length) {
    const list = blocked.map((b) => `${b.address} (${b.reason === 'bounce' ? 'address does not exist' : 'marked your mail as spam'})`)
    throw new EmailError('recipient_suppressed', `Not sending to ${list.join(', ')}. Remove them and try again.`, 409)
  }

  // Mail written in the app leaves from the primary address. The API may also name one of the mailbox's aliases.
  const fromEmail = input.api?.from.email.toLowerCase() ?? mailbox.address
  if (fromEmail !== mailbox.address && !(JSON.parse(mailbox.aliases) as string[]).includes(fromEmail)) {
    throw new EmailError('forbidden_from', 'This mailbox may not send from that address', 403)
  }
  // The display name people see: your own name on your personal mailbox, otherwise the mailbox's name.
  const user = mailbox.kind === 'personal' ? await usersDb.findById(env.DB, actor.userId) : null
  const ownName = (mailbox.kind === 'personal' ? user?.name : mailbox.display_name) ?? mailbox.display_name ?? null
  const fromName = input.api?.from.name ?? ownName
  return { recipients, fromEmail, fromName, ownName }
}

/** Stores an attachment for a message about to be sent. Returns the blob id to pass to sendMessage. */
export async function uploadAttachment(
  env: EmailEnv,
  actor: Actor,
  mailboxId: string,
  body: ReadableStream,
  options: { name: string; contentType: string; size: number },
) {
  const { mailbox } = await mailContext(env, actor, mailboxId, 'write')
  if (!Number.isFinite(options.size) || options.size <= 0) {
    throw new EmailError('invalid_upload', 'Send the file as the request body with a Content-Length')
  }
  if (options.size > MAX_UPLOAD_BYTES) {
    throw new EmailError('attachment_too_large', `Attachments can be at most ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`)
  }
  // File-type rules before the file is kept (sending checks again, mailbox/outbound.ts).
  const byName = checkName(options.name)
  if (byName.level === 'blocked') throw blockedAttachment(options.name, byName)
  const { safety, body: checked } = await inspectStream(body, options.name)
  if (safety.level === 'blocked') {
    await checked.cancel().catch(() => null)
    throw blockedAttachment(options.name, safety)
  }
  // Kept in the organization's bucket until the message is written (mailbox/outbound.ts).
  const bytes = new Uint8Array(await new Response(checked).arrayBuffer())
  return { blobId: await uploadToStore(env, mailbox, bytes, options.contentType), type: options.contentType, size: bytes.byteLength, safety }
}
