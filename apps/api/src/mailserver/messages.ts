// Reading mail and acting on messages. Access comes from mailContext / readableMailboxes in ./access: personal mail
// only for its owner, shared and agent mailboxes for the people allowed in. Everything else is JMAP mail calls in
// ./stalwart/mail, made with the admin key and the mailbox's Stalwart account id.

import type { MailboxRow } from '../db/mailboxes'
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
 * The newest messages in a folder across one or all readable mailboxes. Paging uses the receivedAt of the last
 * message as the cursor; mail that arrived in the same second as a page boundary can be skipped, which is rare.
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

export type UpdateMessageInput = { seen?: boolean; pinned?: boolean; folder?: FolderRole }

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

function folderRole(mailboxIds: Record<string, true>, folders: JmapFolder[]): FolderRole | null {
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
  }
}

function bodyText(parts: JmapBodyPart[], values: JmapEmail['bodyValues']): string {
  return parts.map((p) => (p.partId ? (values[p.partId]?.value ?? '') : '')).join('\n')
}

/** Readable plain text from HTML, for messages sent without a text part. Agents and previews read this. */
function htmlToText(html: string): string {
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
  const textParts = e.textBody.filter((p) => p.type === 'text/plain')
  const html = htmlParts.length ? bodyText(htmlParts, e.bodyValues) : null
  return {
    ...toSummary(e, mailboxId, folders),
    cc: addresses(e.cc),
    replyTo: addresses(e.replyTo),
    sentAt: e.sentAt,
    messageId: e.messageId?.[0] ?? null,
    // JMAP falls back to the HTML part in textBody when there is no plain-text part; keep `text` plain.
    text: textParts.length ? bodyText(textParts, e.bodyValues) : html ? htmlToText(html) : '',
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
