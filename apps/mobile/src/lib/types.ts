// Shapes the API returns. Kept in step with apps/app/src (lib/types.ts, users/api.ts, storage/api.ts, agents/api.ts).

export type User = { id: string; email: string; name: string | null }
export type Org = { id: string; name: string; role: string; memberId?: string; plan?: string }

export type MailboxKind = 'personal' | 'shared' | 'agent'
export type Mailbox = { id: string; kind: MailboxKind; address: string; domainId: string; displayName?: string | null }

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
  threadSize: number
}

export type Attachment = {
  blobId: string
  name: string
  type: string
  size: number
  inline: boolean
  cid: string | null
  /** The API's file-type verdict by name (api/src/security/attachments.ts). Blocked files can't be downloaded. */
  safety?: { level: 'ok' | 'warn' | 'blocked'; code?: string; message?: string }
}
export type Message = MessageSummary & { cc: Address[]; replyTo?: Address[]; text: string; html: string | null; attachments: Attachment[] }

// Users
export type PersonKind = 'user' | 'lead' | 'contact'
export type Person = {
  id: string
  kind: PersonKind
  domain: string
  externalId: string | null
  anonymousId: string | null
  name: string | null
  email: string | null
  phone: string | null
  source: string
  attributes: Record<string, string | number | boolean>
  firstSeenAt: string
  lastSeenAt: string
}
export type Segment = { id: string; name: string; icon: string; count: number }
export type Overview = { total: number; otherContacts?: number; segments: Segment[] }
export type PersonDetail = { person: Person; segments: { id: string; name: string }[]; emails: MessageSummary[] | null }

// Storage
export type StorageItem = {
  id: string
  parentId: string | null
  kind: 'folder' | 'file'
  name: string
  contentType: string | null
  size: number
  updatedAt: string
}
export type Usage = {
  personal: { bytes: number; files: number }
  organization: { bytes: number; files: number }
  attachments: { bytes: number; files: number }
}

// Agents
export type Issue = { kind: string; message: string }
export type AgentSummary = {
  id: string
  name: string
  description: string
  status: 'active' | 'paused'
  hasDraftChanges: boolean
  model: { provider: string; id: string } | null
  pendingApprovals?: number
  issue?: Issue | null
  mailboxes?: string[]
}
export type Health = { issues: Issue[]; monthSpend: number; cap: number | null; memoryFacts: number }
export type Fact = { id: string; subject: string; fact: string; createdAt: string; updatedAt: string }
export type RunStatus = 'running' | 'waiting_for_approval' | 'done' | 'failed' | 'max_steps' | 'skipped'
export type Run = {
  id: string
  status: RunStatus
  trigger: { kind: string; label: string }
  model: string
  task: string
  startedAt: string
  finishedAt: string | null
  steps: number
  cost: number
  summary: string | null
  error: string | null
}
export type RunStep = { seq: number; at: string; kind: string; detail: Record<string, unknown> }
export type Trigger = { id: string; enabled: boolean; summary: string }
export type Approval = {
  id: string
  agentId: string
  runId: string
  toolLabel: string
  reason: string
  status: 'pending' | 'approved' | 'rejected' | 'expired'
  createdAt: string
  expiresAt: string
}

// Settings
export type Domain = { id: string; name: string; status: 'pending' | 'verified'; enabled: boolean }
export type OrgMember = { id: string; name: string | null; email: string; role: 'owner' | 'admin' | 'member'; status: 'invited' | 'active'; you: boolean }
export type ProviderId = 'anthropic' | 'openai'
export type Provider = { provider: ProviderId; status: 'valid' | 'invalid' | 'no_credit' | 'rate_limited'; usedBy: number }
