// Where the Email page gets its mail. Two sources with the same shape:
// - live: the email_* API (folders, messages, threads, updates, attachments), when signed in
// - demo: sample.ts in memory, at /app/?demo
// Shapes match apps/api/src/mailserver/messages.ts (see src/lib/types.ts).

import type { Account } from '../lib/account'
import { api, apiBlob } from '../lib/core'
import { sampleMessages } from '../lib/sample'
import type { Attachment, FolderRole, FolderView, Mailbox, MailboxFolders, Message, MessageSummary, Upload } from '../lib/types'

const PAGE = 50

export type ListQuery = { folder: FolderView; mailboxId?: string; unreadOnly: boolean; query: string; cursor?: string }
export type ListPage = { messages: MessageSummary[]; nextCursor: string | null }
export type Patch = { seen?: boolean; pinned?: boolean; folder?: FolderRole }
export type Outgoing = {
  mailboxId: string
  to: string[]
  cc?: string[]
  bcc?: string[]
  subject: string
  text: string
  /** Message ids in the same mailbox. */
  inReplyTo?: string
  forwardOf?: string
  attachments?: Upload[]
}

export type MailSource = {
  canSend: boolean
  folders(): Promise<MailboxFolders[]>
  list(q: ListQuery): Promise<ListPage>
  thread(summary: MessageSummary): Promise<Message[]>
  update(summary: MessageSummary, patch: Patch): Promise<void>
  state(): Promise<string>
  attachment(message: Message, attachment: Attachment): Promise<Blob>
  send(message: Outgoing): Promise<{ id: string; threadId: string }>
  upload(mailboxId: string, file: File): Promise<Upload>
  clearDraft(summary: MessageSummary): void
}

export function mailSource(account: Account): MailSource {
  return account.mode === 'demo' ? demoSource(account) : liveSource(account.org.id)
}

// ---------------------------------------------------------------------------------------------------------------
// Live

function liveSource(orgId: string): MailSource {
  return {
    canSend: true,

    async folders() {
      return (await api<{ mailboxes: MailboxFolders[] }>('GET', `/email/orgs/${orgId}/folders`)).mailboxes
    },

    list(q) {
      const params = new URLSearchParams({ folder: q.folder, limit: String(PAGE) })
      if (q.mailboxId) params.set('mailboxId', q.mailboxId)
      if (q.unreadOnly) params.set('unreadOnly', 'true')
      if (q.query.trim()) params.set('query', q.query.trim())
      if (q.cursor) params.set('cursor', q.cursor)
      return api<ListPage>('GET', `/email/orgs/${orgId}/messages?${params}`)
    },

    async thread(summary) {
      const path = `/email/mailboxes/${summary.mailboxId}/threads/${encodeURIComponent(summary.threadId)}`
      return (await api<{ messages: Message[] }>('GET', path)).messages
    },

    /** Read state and folder moves apply to the whole conversation; pinning to the one message. */
    async update(summary, patch) {
      const thread = patch.seen !== undefined || patch.folder !== undefined
      await api('PATCH', `/email/mailboxes/${summary.mailboxId}/messages/${encodeURIComponent(summary.id)}`, { ...patch, thread })
    },

    async state() {
      return (await api<{ state: string }>('GET', `/email/orgs/${orgId}/mail-state`)).state
    },

    attachment(message, attachment) {
      const params = new URLSearchParams({ name: attachment.name, type: attachment.type })
      return apiBlob(`/email/mailboxes/${message.mailboxId}/attachments/${encodeURIComponent(attachment.blobId)}?${params}`)
    },

    async send(message) {
      const list = (emails?: string[]) => (emails ?? []).map((email) => ({ email }))
      const { message: sent } = await api<{ message: { id: string; threadId: string } }>('POST', `/email/mailboxes/${message.mailboxId}/send`, {
        to: list(message.to),
        cc: list(message.cc),
        bcc: list(message.bcc),
        subject: message.subject,
        text: message.text,
        ...(message.inReplyTo && { inReplyTo: message.inReplyTo }),
        ...(message.forwardOf && { forwardOf: message.forwardOf }),
        ...(message.attachments?.length && { attachments: message.attachments }),
      })
      return sent
    },

    async upload(mailboxId, file) {
      const path = `/email/mailboxes/${mailboxId}/uploads?name=${encodeURIComponent(file.name)}`
      return (await api<{ attachment: Upload }>('POST', path, undefined, { file })).attachment
    },

    clearDraft() {},
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Demo: sample.ts turned into the same shapes, changed in memory for the page's lifetime.

type DemoMessage = Message & { replies: Message[] }
let demoMessages: DemoMessage[] | null = null

function demoData(mailboxes: Mailbox[]): DemoMessage[] {
  if (demoMessages) return demoMessages
  const byAddress = new Map(mailboxes.map((m) => [m.address, m.id]))
  demoMessages = sampleMessages().map((m) => {
    const own = m.folder === 'sent' ? m.from.email : m.to
    return {
      id: m.id,
      mailboxId: byAddress.get(own) ?? mailboxes[0]?.id ?? '',
      threadId: m.id,
      folder: m.folder === 'spam' ? 'junk' : m.folder,
      from: [{ name: m.from.name, email: m.from.email }],
      to: [{ name: null, email: m.to }],
      cc: [],
      subject: m.subject,
      preview: m.body.join(' '),
      receivedAt: m.time,
      seen: !m.unread,
      pinned: !!m.pinned,
      hasAttachment: false,
      threadSize: 1,
      text: m.body.join('\n\n'),
      html: null,
      attachments: [],
      draft: m.draft ?? null,
      replies: [],
    }
  })
  return demoMessages
}

function summaryOf(m: DemoMessage): MessageSummary {
  const { text: _t, html: _h, attachments: _a, cc: _c, draft: _d, replies, replyTo: _r, ...summary } = m
  return { ...summary, threadSize: 1 + replies.length }
}

function demoSource(account: Account): MailSource {
  const all = () => demoData(account.mailboxes)
  return {
    canSend: true,

    async folders() {
      return account.mailboxes.map((mb) => {
        const mine = all().filter((m) => m.mailboxId === mb.id)
        const count = (role: FolderRole) => mine.filter((m) => m.folder === role)
        const roles: FolderRole[] = ['inbox', 'sent', 'drafts', 'archive', 'junk', 'trash']
        return {
          mailboxId: mb.id,
          address: mb.address,
          kind: mb.kind,
          folders: roles.map((role) => ({
            id: role,
            role,
            name: role,
            unread: count(role).filter((m) => !m.seen).length,
            total: count(role).length,
          })),
        }
      })
    },

    async list(q) {
      const text = q.query.trim().toLowerCase()
      const messages = all()
        .filter((m) => (q.folder === 'pinned' ? m.pinned && m.folder !== 'junk' && m.folder !== 'trash' : m.folder === q.folder))
        .filter((m) => !q.mailboxId || m.mailboxId === q.mailboxId)
        .filter((m) => !q.unreadOnly || !m.seen)
        .filter(
          (m) =>
            !text || [m.subject, m.text, ...m.from.map((a) => `${a.name} ${a.email}`)].some((s) => s?.toLowerCase().includes(text)),
        )
        .sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt))
      return { messages: messages.map(summaryOf), nextCursor: null }
    },

    async thread(summary) {
      const m = all().find((x) => x.id === summary.id)
      if (!m) return []
      const { replies, ...first } = m
      return [{ ...first }, ...replies]
    },

    async update(summary, patch) {
      const m = all().find((x) => x.id === summary.id)
      if (!m) return
      if (patch.seen !== undefined) m.seen = patch.seen
      if (patch.pinned !== undefined) m.pinned = patch.pinned
      if (patch.folder) m.folder = patch.folder
    },

    async state() {
      return 'demo'
    },

    async attachment() {
      return new Blob([''], { type: 'text/plain' })
    },

    /** Adds a reply to the conversation, or a new message to Sent. */
    async send(message) {
      const now = new Date().toISOString()
      const id = message.inReplyTo
      const parent = id ? all().find((x) => x.id === id || x.replies.some((r) => r.id === id)) : undefined
      const from = account.mailboxes.find((mb) => mb.id === message.mailboxId)?.address ?? ''
      const sent: Message = {
        id: `msg_${Date.now()}`,
        mailboxId: message.mailboxId,
        threadId: parent?.threadId ?? `msg_${Date.now()}`,
        folder: 'sent',
        from: [{ name: account.user.name, email: from }],
        to: message.to.map((email) => ({ name: null, email })),
        cc: (message.cc ?? []).map((email) => ({ name: null, email })),
        subject: message.subject,
        preview: message.text,
        receivedAt: now,
        seen: true,
        pinned: false,
        hasAttachment: !!message.attachments?.length,
        threadSize: 1,
        text: message.text,
        html: null,
        attachments: (message.attachments ?? []).map((a) => ({ ...a, size: a.size ?? 0, inline: false, cid: null })),
      }
      if (parent) {
        parent.replies.push(sent)
        parent.seen = true
      } else all().push({ ...sent, draft: null, replies: [] })
      return { id: sent.id, threadId: sent.threadId }
    },

    async upload(_mailboxId, file) {
      return { blobId: `demo-${Date.now()}`, name: file.name, type: file.type || 'application/octet-stream', size: file.size }
    },

    clearDraft(summary) {
      const m = all().find((x) => x.id === summary.id)
      if (m) m.draft = null
    },
  }
}
