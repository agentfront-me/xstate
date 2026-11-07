// Reading mail and acting on messages. Access comes from mailContext / readableMailboxes in ./access: personal mail
// only for its owner, shared and agent mailboxes for the people allowed in. Everything else is JMAP mail calls in
// ./stalwart/mail, made with the admin key and the mailbox's Stalwart account id.

import * as eventsDb from '../db/email-events'
import type { MailboxRow } from '../db/mailboxes'
import * as usersDb from '../db/users'
import { mailContext, readableMailboxes } from './access'
import { EmailError } from './errors'
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
}
export type Message = MessageSummary & {
  cc: Address[]
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
  folder: FolderView
  unreadOnly?: boolean
  query?: string
  /** `nextCursor` from the previous page. */
  cursor?: string
  limit: number
}

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
): Promise<{ messages: MessageSummary[]; nextCursor: string | null }> {
  const mailboxes = await mailboxesFor(env, actor, organizationId, input.mailboxId)
  const folders = await jmap.getFolders(env, mailboxes.map((m) => m.stalwart_id))

  const queries = mailboxes.flatMap((m): { accountId: string; query: jmap.EmailQuery }[] => {
    const list = folders.get(m.stalwart_id) ?? []
    const byRole = (role: FolderRole) => list.filter((f) => f.role === role).map((f) => f.id)
    const base = { unreadOnly: input.unreadOnly, text: input.query?.trim() || undefined, before: input.cursor, limit: input.limit }
    if (input.folder === 'pinned') {
      return [{ accountId: m.stalwart_id, query: { ...base, pinnedOnly: true, notInFolders: [...byRole('junk'), ...byRole('trash')] } }]
    }
    const inFolders = byRole(input.folder)
    // A mailbox without that folder (a shared mailbox may have no Drafts) has nothing to show.
    return inFolders.length ? [{ accountId: m.stalwart_id, query: { ...base, inFolders } }] : []
  })

  const found = await jmap.queryEmails(env, queries)
  const all = mailboxes.flatMap((m) =>
    (found.get(m.stalwart_id) ?? []).map((e) => toSummary(e, m.id, folders.get(m.stalwart_id) ?? [])),
  )
  all.sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt))
  const page = all.slice(0, input.limit)
  const more = all.length > input.limit || [...found.values()].some((list) => list.length === input.limit)
  return { messages: page, nextCursor: more && page.length ? page[page.length - 1]!.receivedAt : null }
}

/** Every message in a conversation, oldest first, with bodies and attachments. Doesn't mark anything read. */
export async function getThread(env: EmailEnv, actor: Actor, mailboxId: string, threadId: string): Promise<Message[]> {
  const { mailbox } = await mailContext(env, actor, mailboxId, 'read')
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
  const upstream = await jmap.downloadBlob(env, mailbox.stalwart_id, blobId, name, type)
  const headers = new Headers({
    'Content-Type': upstream.headers.get('Content-Type') ?? type,
    // Always a download, never rendered: attachments are untrusted content.
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, max-age=300',
  })
  const length = upstream.headers.get('Content-Length')
  if (length) headers.set('Content-Length', length)
  return new Response(upstream.body, { headers })
}

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
    preview: e.preview,
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
  if (textParts.length) return bodyText(textParts, e.bodyValues)
  const htmlParts = e.htmlBody.filter((p) => p.type === 'text/html')
  return htmlParts.length ? htmlToText(bodyText(htmlParts, e.bodyValues)) : ''
}

/** Readable plain text from HTML, for messages sent without a text part. Agents and previews read this. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function toMessage(e: JmapEmail, mailboxId: string, folders: JmapFolder[]): Message {
  const htmlParts = e.htmlBody.filter((p) => p.type === 'text/html')
  const html = htmlParts.length ? bodyText(htmlParts, e.bodyValues) : null
  return {
    ...toSummary(e, mailboxId, folders),
    cc: addresses(e.cc),
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
      })),
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Sending

/** At most this many To + Cc + Bcc recipients per message. Bulk mail isn't what xstate is for. */
export const MAX_RECIPIENTS = 50
/** Largest attachment upload, matching what most mail servers accept for a whole message. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024

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
  const { mailbox } = await mailContext(env, actor, mailboxId, 'write')
  const accountId = mailbox.stalwart_id

  const recipients = [...input.to, ...(input.cc ?? []), ...(input.bcc ?? [])]
  if (!recipients.length) throw new EmailError('no_recipients', 'Add at least one recipient')
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

  // The display name people see: your own name on your personal mailbox, otherwise the mailbox's name.
  const fromName = (mailbox.kind === 'personal' ? user?.name : mailbox.display_name) ?? mailbox.display_name ?? null
  const identityId =
    identities.find((i) => i.email.toLowerCase() === mailbox.address)?.id ??
    (await jmap.createIdentity(env, accountId, { name: fromName ?? '', email: mailbox.address }))

  const email: Record<string, unknown> = {
    from: [{ name: fromName, email: mailbox.address }],
    to: input.to,
    subject: input.subject,
  }
  if (input.cc?.length) email.cc = input.cc
  if (input.bcc?.length) email.bcc = input.bcc

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

  // Attachments may only come from this account: uploads to it, or the forwarded message's own parts.
  const attachments = input.attachments ?? []
  if (input.forwardOf && original) {
    for (const part of original.attachments) {
      if (part.blobId && !attachments.some((a) => a.blobId === part.blobId)) {
        attachments.push({ blobId: part.blobId, name: part.name ?? 'attachment', type: part.type })
      }
    }
  }

  const body: Record<string, unknown> = input.html
    ? { type: 'multipart/alternative', subParts: [{ partId: 'text', type: 'text/plain' }, { partId: 'html', type: 'text/html' }] }
    : { partId: 'text', type: 'text/plain' }
  email.bodyValues = { text: { value: input.text }, ...(input.html && { html: { value: input.html } }) }
  email.bodyStructure = attachments.length
    ? {
        type: 'multipart/mixed',
        subParts: [
          body,
          ...attachments.map((a) => ({ blobId: a.blobId, type: a.type, name: a.name, disposition: 'attachment' })),
        ],
      }
    : body

  const sent = await jmap.submitEmail(env, accountId, { identityId, draftsId, sentId, email })
  if (original) {
    await jmap
      .addKeyword(env, accountId, original.id, input.inReplyTo ? '$answered' : '$forwarded')
      .catch((err) => console.error('send: marking original failed', err))
  }
  return sent
}

/** Stores an attachment for a message about to be sent. Returns the blob id to pass to sendMessage. */
export async function uploadAttachment(
  env: EmailEnv,
  actor: Actor,
  mailboxId: string,
  body: ReadableStream,
  options: { contentType: string; size: number },
) {
  const { mailbox } = await mailContext(env, actor, mailboxId, 'write')
  if (!Number.isFinite(options.size) || options.size <= 0) {
    throw new EmailError('invalid_upload', 'Send the file as the request body with a Content-Length')
  }
  if (options.size > MAX_UPLOAD_BYTES) {
    throw new EmailError('attachment_too_large', `Attachments can be at most ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`)
  }
  return jmap.uploadBlob(env, mailbox.stalwart_id, body, options.contentType, options.size)
}
