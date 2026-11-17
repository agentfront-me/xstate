// Reading mail and acting on messages. Access comes from mailContext / readableMailboxes in ./access: personal mail
// only for its owner, shared and agent mailboxes for the people allowed in. Everything else is JMAP mail calls in
// ./stalwart/mail, made with the admin key and the mailbox's Stalwart account id.

import * as eventsDb from '../db/email-events'
import type { MailboxRow } from '../db/mailboxes'
import * as usersDb from '../db/users'
import { checkName, inspectStream, type Safety } from '../security/attachments'
import { refuseVirus } from '../security/refuse'
import { scanning } from '../security/scan'
import { mailContext, readableMailboxes } from './access'
import { previewText } from './footer'
import { htmlToText } from './html-text'
import { readableText } from '../mailbox/compare'
import { parseStoreBlobId, readsFromStore, serverBlobId, storeBlob, storeThread } from '../mailbox/read'
import { store } from '../mailbox/stub'
import type { StoreListRow } from '../mailbox/query'
import { EmailError } from './errors'
import { reserveSend } from './sending'
import * as jmap from './stalwart/mail'
import type { FolderRole, JmapAddress, JmapBodyPart, JmapEmail, JmapEmailSummary, JmapFolder } from './stalwart/mail'
import type { Actor, EmailEnv } from './types'

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
  const folders = await jmap.getFolders(env, mailboxes.map((m) => m.stalwart_id))
  return mailboxes.map((m) => ({
    mailboxId: m.id,
    address: m.address,
    kind: m.kind,
    folders: (folders.get(m.stalwart_id) ?? []).map(toFolder),
  }))
}

function toFolder(f: JmapFolder): Folder {
  return {
    id: f.id,
    role: ROLES.includes(f.role as FolderRole) ? (f.role as FolderRole) : null,
    name: f.name,
    unread: f.unreadEmails,
    total: f.totalEmails,
  }
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

/** Preview lengths: Stalwart's own previews are 256 characters. */
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
  const readable = await mailboxesFor(env, actor, organizationId, input.mailboxId)
  // Mailboxes whose lists are answered by their own store (mailbox/store.ts); the rest ask Stalwart.
  const stored = readable.filter((m) => m.store_mode === 'read')
  const mailboxes = readable.filter((m) => m.store_mode !== 'read')
  const text = (v: string | undefined) => v?.trim() || undefined
  const [folders, fromStores] = await Promise.all([
    jmap.getFolders(env, mailboxes.map((m) => m.stalwart_id)),
    Promise.all(
      stored.map(async (m) => {
        const stub = await store(env, m.id)
        const page = await stub.list({
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
    ),
  ])

  const queries = mailboxes.flatMap((m): { accountId: string; query: jmap.EmailQuery }[] => {
    const list = folders.get(m.stalwart_id) ?? []
    const byRole = (role: FolderRole) => list.filter((f) => f.role === role).map((f) => f.id)
    const base: jmap.EmailQuery = {
      unreadOnly: input.unreadOnly,
      text: text(input.query),
      from: text(input.from),
      to: text(input.to),
      subject: text(input.subject),
      after: input.after,
      before: earliest(input.cursor, input.before),
      hasAttachment: input.hasAttachment,
      limit: input.limit,
    }
    if (input.folder === 'pinned' || input.folder === 'all') {
      const notInFolders = [...byRole('junk'), ...byRole('trash')]
      return [{ accountId: m.stalwart_id, query: { ...base, pinnedOnly: input.folder === 'pinned', notInFolders } }]
    }
    const inFolders = byRole(input.folder)
    // A mailbox without that folder (a shared mailbox may have no Drafts) has nothing to show.
    return inFolders.length ? [{ accountId: m.stalwart_id, query: { ...base, inFolders } }] : []
  })

  const found = await jmap.queryEmails(env, queries)
  const all = [
    ...mailboxes.flatMap((m) => (found.get(m.stalwart_id) ?? []).map((e) => toSummary(e, m.id, folders.get(m.stalwart_id) ?? []))),
    ...fromStores.flatMap((s) => s.messages),
  ]
  all.sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt))
  const page = all.slice(0, input.limit)
  const more = all.length > input.limit || [...found.values()].some((list) => list.length === input.limit) || fromStores.some((s) => s.more)
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
  const folders = await jmap.getFolders(env, mailboxes.map((m) => m.stalwart_id))
  const queries = mailboxes.map((m) => {
    const skip = (folders.get(m.stalwart_id) ?? []).filter((f) => f.role === 'junk' || f.role === 'trash').map((f) => f.id)
    return { accountId: m.stalwart_id, query: { participant: address, notInFolders: skip, collapseThreads: false, limit } }
  })
  const found = await jmap.queryEmails(env, queries)
  const all = mailboxes.flatMap((m) => (found.get(m.stalwart_id) ?? []).map((e) => toSummary(e, m.id, folders.get(m.stalwart_id) ?? [])))
  all.sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt))
  return all.slice(0, limit)
}

/** Every message in a conversation, oldest first, with bodies and attachments. Doesn't mark anything read. */
export async function getThread(env: EmailEnv, actor: Actor, mailboxId: string, threadId: string): Promise<Message[]> {
  const { mailbox } = await mailContext(env, actor, mailboxId, 'read')
  if (readsFromStore(env, mailbox)) {
    const fromStoreCopy = await storeThread(env, mailbox, threadId, (row) => fromStore(row, mailbox.id))
    if (fromStoreCopy) return fromStoreCopy
  }
  const [emails, folders] = await Promise.all([
    jmap.getThread(env, mailbox.stalwart_id, threadId),
    jmap.getFolders(env, [mailbox.stalwart_id]),
  ])
  return emails.map((e) => toMessage(e, mailbox.id, folders.get(mailbox.stalwart_id) ?? []))
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
  let folderId: string | undefined
  if (input.folder) {
    const folders = (await jmap.getFolders(env, [mailbox.stalwart_id])).get(mailbox.stalwart_id) ?? []
    folderId = folders.find((f) => f.role === input.folder)?.id
    // Stalwart doesn't create an Archive folder for new accounts; make it the first time someone archives.
    if (!folderId && input.folder === 'archive') folderId = await jmap.createFolder(env, mailbox.stalwart_id, 'Archive', 'archive')
    if (!folderId) throw new EmailError('folder_not_found', `This mailbox has no ${input.folder} folder`, 404)
  }
  if (input.thread && (input.seen !== undefined || folderId)) {
    await jmap.updateThreadOf(env, mailbox.stalwart_id, messageId, { seen: input.seen, folderId })
    if (input.pinned === undefined) return
    return jmap.updateEmail(env, mailbox.stalwart_id, messageId, { pinned: input.pinned })
  }
  await jmap.updateEmail(env, mailbox.stalwart_id, messageId, { seen: input.seen, pinned: input.pinned, folderId })
}

/**
 * An opaque token that changes whenever mail changes in any mailbox the actor can read. The dashboard polls it
 * and reloads when it differs.
 */
export async function getMailState(env: EmailEnv, actor: Actor, organizationId: string): Promise<string> {
  const mailboxes = await readableMailboxes(env, actor, organizationId)
  const states = await jmap.getEmailStates(env, mailboxes.map((m) => m.stalwart_id))
  return mailboxes.map((m) => `${m.id}:${states.get(m.stalwart_id) ?? ''}`).join(',')
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
  let upstream: Response
  if (parseStoreBlobId(blobId)) {
    // An attachment of a message read from the mailbox's store: read back from its raw copy.
    const blob = await storeBlob(env, mailbox, blobId)
    if (!blob) throw new EmailError('attachment_not_found', 'That attachment no longer exists', 404)
    upstream = new Response(blob.bytes, { headers: { 'Content-Type': type || blob.type, 'Content-Length': String(blob.bytes.byteLength) } })
  } else {
    upstream = await jmap.downloadBlob(env, mailbox.stalwart_id, blobId, name, type)
  }
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

/**
 * Reads an attachment already on the mail server far enough to judge it (security/attachments), and its size from
 * the same response (null when the server doesn't say, or the name alone already blocks it).
 */
async function blobSafety(
  env: EmailEnv,
  accountId: string,
  a: { blobId: string; name: string; type: string },
): Promise<{ safety: Safety; size: number | null }> {
  const byName = checkName(a.name)
  if (byName.level === 'blocked') return { safety: byName, size: null }
  const res = await jmap.downloadBlob(env, accountId, a.blobId, a.name, a.type)
  const length = Number(res.headers.get('Content-Length'))
  const { safety, body } = await inspectStream(res.body!, a.name)
  await body.cancel().catch(() => null)
  return { safety, size: Number.isFinite(length) && length > 0 ? length : null }
}

const attachmentsTooLarge = (total: number) =>
  new EmailError(
    'attachments_too_large',
    `Attachments add up to ${(total / 1024 / 1024).toFixed(1)} MB; a message can carry at most ${MAX_ATTACHMENTS_BYTES / 1024 / 1024} MB. ` +
      'Remove some, or share large files from Storage as a link.',
  )

// ---------------------------------------------------------------------------------------------------------------

async function mailboxesFor(env: EmailEnv, actor: Actor, organizationId: string, mailboxId?: string): Promise<MailboxRow[]> {
  if (!mailboxId) return readableMailboxes(env, actor, organizationId)
  const { mailbox } = await mailContext(env, actor, mailboxId, 'read')
  if (mailbox.organization_id !== organizationId) throw new EmailError('mailbox_not_found', 'Mailbox not found', 404)
  return [mailbox]
}

const addresses = (list: JmapAddress[] | null): Address[] => (list ?? []).map((a) => ({ name: a.name || null, email: a.email }))

/** The folder a message is "in" for people, among the ones it sits in; null for a custom folder only. */
export function folderRole(mailboxIds: Record<string, true>, folders: JmapFolder[]): FolderRole | null {
  const roles = folders.filter((f) => mailboxIds[f.id]).map((f) => f.role)
  // A message can sit in several folders; prefer the one people think of it being "in".
  return ROLES.find((r) => roles.includes(r)) ?? null
}

function toSummary(e: JmapEmailSummary, mailboxId: string, folders: JmapFolder[]): MessageSummary {
  return {
    id: e.id,
    mailboxId,
    threadId: e.threadId,
    folder: folderRole(e.mailboxIds, folders),
    from: addresses(e.from),
    to: addresses(e.to),
    subject: e.subject ?? '',
    preview: previewText(e.preview, PREVIEW_MAX),
    receivedAt: e.receivedAt,
    seen: !!e.keywords.$seen,
    pinned: !!e.keywords.$flagged,
    hasAttachment: e.hasAttachment,
    size: e.size,
    threadSize: e.threadSize ?? 1,
  }
}

export function bodyText(parts: JmapBodyPart[], values: JmapEmail['bodyValues']): string {
  return parts.map((p) => (p.partId ? (values[p.partId]?.value ?? '') : '')).join('\n')
}

/** A message's readable text: its plain-text part, or its HTML part as text. Agents, previews and search read this. */
export function plainText(e: Pick<JmapEmail, 'textBody' | 'htmlBody' | 'bodyValues'>): string {
  const textParts = e.textBody.filter((p) => p.type === 'text/plain')
  const htmlParts = e.htmlBody.filter((p) => p.type === 'text/html')
  // Some senders include an empty plain-text part next to the real HTML one: then the HTML is the body.
  return readableText(
    textParts.length ? bodyText(textParts, e.bodyValues) : undefined,
    htmlParts.length ? bodyText(htmlParts, e.bodyValues) : undefined,
    htmlToText,
  )
}

/** Readable plain text from HTML, for messages sent without a text part. Agents, previews and search read this. */
export { htmlToText }

function toMessage(e: JmapEmail, mailboxId: string, folders: JmapFolder[]): Message {
  const htmlParts = e.htmlBody.filter((p) => p.type === 'text/html')
  const html = htmlParts.length ? bodyText(htmlParts, e.bodyValues) : null
  return {
    ...toSummary(e, mailboxId, folders),
    cc: addresses(e.cc),
    bcc: addresses(e.bcc),
    replyTo: addresses(e.replyTo),
    sentAt: e.sentAt,
    messageId: e.messageId?.[0] ?? null,
    // JMAP falls back to the HTML part in textBody when there is no plain-text part; keep `text` plain.
    text: plainText(e),
    html,
    attachments: e.attachments
      .filter((p): p is JmapBodyPart & { blobId: string } => !!p.blobId)
      .map((p) => ({
        blobId: p.blobId,
        name: p.name || 'attachment',
        type: p.type,
        size: p.size,
        inline: p.disposition === 'inline',
        cid: p.cid?.replace(/^<|>$/g, '') ?? null,
        safety: checkName(p.name || 'attachment'),
      })),
  }
}

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

/**
 * Sends a message from the mailbox's primary address. The message is created in Drafts and submitted in one
 * step; Stalwart moves it to Sent. Mail to other xstate addresses is delivered at once; outside addresses go
 * through Stalwart's outbound route (Amazon SES).
 */
export async function sendMessage(
  env: EmailEnv,
  actor: Actor,
  mailboxId: string,
  input: SendInput,
): Promise<{ id: string; threadId: string }> {
  const { mailbox, accountId, identityId, draftsId, sentId, email, original, recipients } = await compose(env, actor, mailboxId, input, true)

  // Last check before anything leaves: suspension and the hourly and daily caps (./sending).
  const reservation = await reserveSend(env, mailbox, recipients.map((r) => r.email))
  const sent = await jmap.submitEmail(env, accountId, { identityId, draftsId, sentId, email, keepCopy: input.api?.keepCopy }).catch(async (err) => {
    await reservation.release()
    throw err
  })
  if (input.draftId) await dropDraft(env, accountId, input.draftId)
  if (original) {
    await jmap
      .addKeyword(env, accountId, original.id, input.inReplyTo ? '$answered' : '$forwarded')
      .catch((err) => console.error('send: marking original failed', err))
  }
  return sent
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
  const { accountId, draftsId, email } = await compose(env, actor, mailboxId, input, false)
  const saved = await jmap.createDraft(env, accountId, draftsId, email)
  if (input.draftId) await dropDraft(env, accountId, input.draftId)
  return saved
}

/** Deletes the draft a message replaced. The new message already exists, so a failure here only leaves a copy. */
async function dropDraft(env: EmailEnv, accountId: string, draftId: string) {
  await jmap.destroyEmail(env, accountId, draftId).catch((err) => console.error('drafts: deleting the old draft failed', err))
}

/** The JMAP email for sendMessage and saveDraft, after the access, recipient and folder checks. */
async function compose(env: EmailEnv, actor: Actor, mailboxId: string, input: SendInput, sending: boolean) {
  const { mailbox } = await mailContext(env, actor, mailboxId, 'write')
  const accountId = mailbox.stalwart_id

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

  const [folders, identities, user] = await Promise.all([
    jmap.getFolders(env, [accountId]).then((m) => m.get(accountId) ?? []),
    jmap.getIdentities(env, accountId),
    usersDb.findById(env.DB, actor.userId),
  ])
  const draftsId = folders.find((f) => f.role === 'drafts')?.id
  const sentId = folders.find((f) => f.role === 'sent')?.id
  if (!draftsId || !sentId) throw new EmailError('folder_not_found', 'This mailbox has no Drafts or Sent folder', 409)

  // Mail written in the app leaves from the primary address. The API may also name one of the mailbox's aliases.
  const fromEmail = input.api?.from.email.toLowerCase() ?? mailbox.address
  if (fromEmail !== mailbox.address && !(JSON.parse(mailbox.aliases) as string[]).includes(fromEmail)) {
    throw new EmailError('forbidden_from', 'This mailbox may not send from that address', 403)
  }
  // The display name people see: your own name on your personal mailbox, otherwise the mailbox's name.
  const ownName = (mailbox.kind === 'personal' ? user?.name : mailbox.display_name) ?? mailbox.display_name ?? null
  const fromName = input.api?.from.name ?? ownName
  const identityId =
    identities.find((i) => i.email.toLowerCase() === fromEmail)?.id ??
    (await jmap.createIdentity(env, accountId, { name: ownName ?? '', email: fromEmail }))

  const email: Record<string, unknown> = {
    from: [{ name: fromName, email: fromEmail }],
    to: input.to,
    subject: input.subject,
  }
  if (input.cc?.length) email.cc = input.cc
  if (input.bcc?.length) email.bcc = input.bcc
  if (input.api) {
    email.messageId = [input.api.messageId]
    if (input.api.replyTo?.length) email.replyTo = input.api.replyTo
    // Raw form, so any allowed header can be set the same way (asText isn't allowed for List-Unsubscribe).
    for (const [name, value] of Object.entries(input.api.headers ?? {})) email[`header:${name}:asRaw`] = value
  }

  let original: jmap.ReplySource | null = null
  const sourceId = input.inReplyTo ?? input.forwardOf
  if (sourceId) {
    original = await jmap.getReplySource(env, accountId, sourceId)
    if (!original) throw new EmailError('message_not_found', 'The message you are replying to no longer exists', 404)
    if (input.inReplyTo && original.messageId?.length) {
      email.inReplyTo = original.messageId
      email.references = [...(original.references ?? []), ...original.messageId]
    }
  }

  // Finishing a saved draft: it must still be a draft in this mailbox, and a reply keeps its place in the thread.
  if (input.draftId) {
    const draft = await jmap.getDraftHeaders(env, accountId, input.draftId)
    if (!draft || !draft.mailboxIds[draftsId] || !draft.keywords.$draft) {
      throw new EmailError('draft_not_found', 'That draft no longer exists. It may have been sent or deleted.', 404)
    }
    if (!email.inReplyTo && draft.inReplyTo?.length) {
      email.inReplyTo = draft.inReplyTo
      email.references = draft.references?.length ? draft.references : draft.inReplyTo
    }
  }

  // Attachments may only come from this account: uploads to it, or the forwarded message's own parts. One picked
  // from a message read from the mailbox's store is handed to the mail server first.
  const attachments = await Promise.all(
    (input.attachments ?? []).map(async (a) => ({ ...a, blobId: await serverBlobId(env, mailbox, a.blobId, a.type) })),
  )
  const forwarded: (typeof attachments[number] & { size: number })[] = []
  if (input.forwardOf && original) {
    for (const part of original.attachments) {
      if (part.blobId && !attachments.some((a) => a.blobId === part.blobId)) {
        forwarded.push({ blobId: part.blobId, name: part.name ?? 'attachment', type: part.type, size: part.size })
      }
    }
  }
  // File-type rules on every file, uploads included: a blob id could also point at a received attachment. A
  // blocked file someone chose fails the send; a blocked file that only came along with a forward is left out.
  const [chosen, carried] = await Promise.all([
    Promise.all(attachments.map((a) => blobSafety(env, accountId, a))),
    Promise.all(forwarded.map((a) => blobSafety(env, accountId, a))),
  ])
  const refused = chosen.findIndex((c) => c.safety.level === 'blocked')
  if (refused >= 0) throw blockedAttachment(attachments[refused]!.name, chosen[refused]!.safety)
  const kept = forwarded.filter((_, i) => carried[i]!.safety.level !== 'blocked')
  attachments.push(...kept)

  // One rule for drafts and sent mail alike: a draft over the limit couldn't be sent anyway.
  const total = chosen.reduce((sum, c) => sum + (c.size ?? 0), 0) + kept.reduce((sum, a) => sum + a.size, 0)
  if (total > MAX_ATTACHMENTS_BYTES) throw attachmentsTooLarge(total)

  // Images the HTML shows with cid: travel next to it (multipart/related); every other file is a plain attachment.
  const cidOf = new Map(Object.entries(input.api?.inline ?? {}).map(([cid, blobId]) => [blobId, cid]))
  const inline = input.html ? attachments.filter((a) => cidOf.has(a.blobId)) : []
  const files = attachments.filter((a) => !inline.includes(a))
  const htmlPart: Record<string, unknown> = inline.length
    ? {
        type: 'multipart/related',
        subParts: [
          { partId: 'html', type: 'text/html' },
          ...inline.map((a) => ({ blobId: a.blobId, type: a.type, name: a.name, disposition: 'inline', cid: cidOf.get(a.blobId) })),
        ],
      }
    : { partId: 'html', type: 'text/html' }
  const body: Record<string, unknown> = input.html
    ? { type: 'multipart/alternative', subParts: [{ partId: 'text', type: 'text/plain' }, htmlPart] }
    : { partId: 'text', type: 'text/plain' }
  email.bodyValues = { text: { value: input.text }, ...(input.html && { html: { value: input.html } }) }
  email.bodyStructure = files.length
    ? {
        type: 'multipart/mixed',
        subParts: [
          body,
          ...files.map((a) => ({ blobId: a.blobId, type: a.type, name: a.name, disposition: 'attachment' })),
        ],
      }
    : body

  return { mailbox, accountId, identityId, draftsId, sentId, email, original, recipients }
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
  // File-type rules before anything reaches the mail server (sending checks again, see compose).
  const byName = checkName(options.name)
  if (byName.level === 'blocked') throw blockedAttachment(options.name, byName)
  const { safety, body: checked } = await inspectStream(body, options.name)
  if (safety.level === 'blocked') {
    await checked.cancel().catch(() => null)
    throw blockedAttachment(options.name, safety)
  }
  if (!scanning(env)) {
    const blob = await jmap.uploadBlob(env, mailbox.stalwart_id, checked, options.contentType, options.size)
    return { ...blob, safety }
  }
  // Virus scan before the mail server sees it. The file (25 MB at most) is held in memory for the two sends.
  const bytes = new Uint8Array(await new Response(checked).arrayBuffer())
  await refuseVirus(env, bytes, options.name)
  const blob = await jmap.uploadBlob(env, mailbox.stalwart_id, bytes, options.contentType, bytes.byteLength)
  return { ...blob, safety }
}
