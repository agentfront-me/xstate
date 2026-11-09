// Shapes the API returns (apps/api/src/mailserver/types.ts and messages.ts), plus demo-only extras.

export type User = { id: string; email: string; name: string | null }
export type Org = { id: string; name: string; role: string; memberId?: string; plan?: string }

export type Domain = {
  id: string
  name: string
  status: 'pending' | 'verified'
  /** Proven to be the organization's (ownership TXT record or mail records), even before mail moves. */
  owned?: boolean
  /** Amazon SES state: whether mail from this domain can reach outside addresses yet. */
  sending?: 'pending' | 'verified' | 'failed' | null
  enabled: boolean
}

export type MailboxKind = 'personal' | 'shared' | 'agent'
export type Mailbox = { id: string; kind: MailboxKind; address: string; domainId: string; displayName?: string | null }

export type DnsRecord = { type: string; name: string; value: string; found: boolean; required: boolean; purpose?: string }

export type FolderRole = 'inbox' | 'sent' | 'drafts' | 'archive' | 'junk' | 'trash'
export type FolderView = FolderRole | 'pinned'
export type Folder = { id: string; role: FolderRole | null; name: string; unread: number; total: number }
export type MailboxFolders = { mailboxId: string; address: string; kind: MailboxKind; folders: Folder[] }

export type Address = { name: string | null; email: string }

export type MessageSummary = {
  id: string
  mailboxId: string
  threadId: string
  folder: FolderRole | null
  from: Address[]
  to: Address[]
  subject: string
  preview: string
  receivedAt: string
  seen: boolean
  pinned: boolean
  hasAttachment: boolean
  /** Messages in the conversation. The list shows one row per conversation. */
  threadSize: number
}

export type Attachment = { blobId: string; name: string; type: string; size: number; inline: boolean; cid: string | null }

/** A reply an agent suggested (demo only for now). */
export type Draft = { agent: string; from: string; body: string }

export type Message = MessageSummary & {
  cc: Address[]
  replyTo?: Address[]
  text: string
  html: string | null
  attachments: Attachment[]
  draft?: Draft | null
}

/** An attachment uploaded for a message about to be sent. */
export type Upload = { blobId: string; name: string; type: string; size?: number }
