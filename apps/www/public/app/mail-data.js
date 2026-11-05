// Where the Email view gets its mail. Two sources with the same shape:
// - live: the email_* API (folders, messages, threads, updates, attachments), when signed in
// - demo: sample.js in memory, at /app/?demo
//
// Shapes (match apps/api/src/mailserver/messages.ts):
//   MailboxFolders  { mailboxId, address, kind, folders: [{ id, role, name, unread, total }] }
//   Summary         { id, mailboxId, threadId, folder, from: [{name,email}], to, subject, preview, receivedAt,
//                     seen, pinned, hasAttachment }
//   Message         Summary + { cc, text, html, attachments: [{ blobId, name, type, size, inline, cid }] }
// Demo-only extras on a Message: `draft` (an agent's suggested reply).

import { api } from './core.js'
import { sampleMessages } from './sample.js'
import { isDemo, store } from './store.js'

const PAGE = 50

/** Which source is in use. */
export const source = () => (isDemo() ? demo : live)

// ---------------------------------------------------------------------------------------------------------------
// Live

const live = {
  async folders() {
    const { mailboxes } = await api('GET', `/email/orgs/${store.org.id}/folders`)
    return mailboxes
  },

  /** `view`: { folder, mailboxId?, unreadOnly, query, cursor } */
  async list(view) {
    const params = new URLSearchParams({ folder: view.folder, limit: String(PAGE) })
    if (view.mailboxId) params.set('mailboxId', view.mailboxId)
    if (view.unreadOnly) params.set('unreadOnly', 'true')
    if (view.query?.trim()) params.set('query', view.query.trim())
    if (view.cursor) params.set('cursor', view.cursor)
    return api('GET', `/email/orgs/${store.org.id}/messages?${params}`)
  },

  async thread(summary) {
    const { messages } = await api('GET', `/email/mailboxes/${summary.mailboxId}/threads/${encodeURIComponent(summary.threadId)}`)
    return messages
  },

  update(summary, patch) {
    return api('PATCH', `/email/mailboxes/${summary.mailboxId}/messages/${encodeURIComponent(summary.id)}`, patch)
  },

  async state() {
    return (await api('GET', `/email/orgs/${store.org.id}/mail-state`)).state
  },

  /** The attachment as a Blob. */
  async attachment(message, attachment) {
    const params = new URLSearchParams({ name: attachment.name, type: attachment.type })
    return api('GET', `/email/mailboxes/${message.mailboxId}/attachments/${encodeURIComponent(attachment.blobId)}?${params}`, undefined, {
      raw: true,
    })
  },

  canSend: true,

  /**
   * `message`: { mailboxId, to, cc, bcc (arrays of addresses), subject, text, inReplyTo?, forwardOf?,
   * attachments? [{ blobId, name, type }] }. inReplyTo and forwardOf are message ids in the same mailbox.
   */
  async send(message) {
    const list = (emails) => (emails ?? []).map((email) => ({ email }))
    const { message: sent } = await api('POST', `/email/mailboxes/${message.mailboxId}/send`, {
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

  /** Uploads a File for a message about to be sent from the mailbox. */
  async upload(mailboxId, file) {
    const { attachment } = await api('POST', `/email/mailboxes/${mailboxId}/uploads?name=${encodeURIComponent(file.name)}`, undefined, {
      file,
    })
    return attachment
  },

  clearDraft() {},
}

// ---------------------------------------------------------------------------------------------------------------
// Demo: sample.js turned into the same shapes, changed in memory.

let demoMessages = null

function demoData() {
  if (demoMessages) return demoMessages
  const byAddress = new Map(store.mailboxes.map((m) => [m.address, m.id]))
  demoMessages = sampleMessages().map((m) => {
    const own = m.folder === 'sent' ? m.from.email : m.to
    return {
      id: m.id,
      mailboxId: byAddress.get(own) ?? store.mailboxes[0]?.id,
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
      text: m.body.join('\n\n'),
      html: null,
      attachments: [],
      draft: m.draft ?? null,
      replies: [],
    }
  })
  return demoMessages
}

const demo = {
  async folders() {
    const all = demoData()
    return store.mailboxes.map((mb) => {
      const mine = all.filter((m) => m.mailboxId === mb.id)
      const count = (role) => mine.filter((m) => m.folder === role)
      return {
        mailboxId: mb.id,
        address: mb.address,
        kind: mb.kind,
        folders: ['inbox', 'sent', 'drafts', 'archive', 'junk', 'trash'].map((role) => ({
          id: role,
          role,
          name: role,
          unread: count(role).filter((m) => !m.seen).length,
          total: count(role).length,
        })),
      }
    })
  },

  async list(view) {
    const q = view.query?.trim().toLowerCase()
    const messages = demoData()
      .filter((m) => (view.folder === 'pinned' ? m.pinned && m.folder !== 'junk' && m.folder !== 'trash' : m.folder === view.folder))
      .filter((m) => !view.mailboxId || m.mailboxId === view.mailboxId)
      .filter((m) => !view.unreadOnly || !m.seen)
      .filter((m) => !q || [m.subject, m.text, ...m.from.map((a) => `${a.name} ${a.email}`)].some((s) => s?.toLowerCase().includes(q)))
      .sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt))
    return { messages: messages.map(summaryOf), nextCursor: null }
  },

  async thread(summary) {
    const m = demoData().find((x) => x.id === summary.id)
    return m ? [{ ...m }, ...m.replies] : []
  },

  async update(summary, patch) {
    const m = demoData().find((x) => x.id === summary.id)
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

  canSend: true,

  /** Adds a reply to the conversation, or a new message to Sent. Same `message` shape as live.send. */
  async send(message) {
    const now = new Date().toISOString()
    const id = message.inReplyTo
    const parent = id && demoData().find((x) => x.id === id || x.replies.some((r) => r.id === id))
    const from = store.mailboxes.find((mb) => mb.id === message.mailboxId)?.address ?? ''
    const sent = {
      id: `msg_${Date.now()}`,
      mailboxId: message.mailboxId,
      threadId: parent?.threadId ?? `msg_${Date.now()}`,
      folder: 'sent',
      from: [{ name: store.user.name, email: from }],
      to: message.to.map((email) => ({ name: null, email })),
      cc: (message.cc ?? []).map((email) => ({ name: null, email })),
      subject: message.subject,
      preview: message.text,
      receivedAt: now,
      seen: true,
      pinned: false,
      hasAttachment: !!message.attachments?.length,
      text: message.text,
      html: null,
      attachments: (message.attachments ?? []).map((a) => ({ ...a, size: a.size ?? 0, inline: false, cid: null })),
    }
    if (parent) {
      parent.replies.push(sent)
      parent.seen = true
    } else demoData().push({ ...sent, draft: null, replies: [] })
    return { id: sent.id, threadId: sent.threadId }
  },

  async upload(_mailboxId, file) {
    return { blobId: `demo-${Date.now()}`, name: file.name, type: file.type || 'application/octet-stream', size: file.size }
  },

  clearDraft(summary) {
    const m = demoData().find((x) => x.id === summary.id)
    if (m) m.draft = null
  },
}

function summaryOf(m) {
  const { text, html, attachments, cc, draft, replies, ...summary } = m
  return summary
}
