// The storage_* API (apps/api/src/operations/storage.ts). Shapes match apps/api/src/storage/drive.ts.

import { api, apiBlob, apiUrl, APP_ORIGIN, desktop } from '../lib/core'

export type Space = 'personal' | 'organization'
export type Role = 'viewer' | 'editor' | 'manager'
export type OrgAccess = 'viewer' | 'editor'
export type TopView = 'personal' | 'organization' | 'shared' | 'trash'

export type StorageItem = {
  id: string
  organizationId: string
  space: Space
  parentId: string | null
  kind: 'folder' | 'file'
  name: string
  contentType: string | null
  size: number
  version: number
  orgAccess: OrgAccess | null
  shared: boolean
  /** People with a grant on this item itself. */
  people: number
  /** Has a public link of its own: anyone with it can view, without signing in. */
  publicLink: boolean
  role: Role
  owner: { memberId: string; name: string | null; email: string } | null
  updatedBy: string | null
  createdAt: string
  updatedAt: string
  trashedAt: string | null
}

export type PathEntry = { id: string; name: string }

export type MailAttachment = {
  id: string
  mailboxId: string
  name: string
  contentType: string
  size: number
  source: 'received' | 'sent'
  emailId: string | null
  threadId: string | null
  createdAt: string
}

export type AttachmentMailbox = { id: string; address: string; displayName: string | null; kind: string; count: number; bytes: number }

export type Usage = {
  personal: { bytes: number; files: number }
  organization: { bytes: number; files: number }
  attachments: { bytes: number; files: number }
  trash: { items: number }
}

export type Version = {
  version: number
  size: number
  savedAt: string
  savedBy: string | null
  current: boolean
  expiresAt: string | null
}

export type Person = { memberId: string; name: string | null; email: string; role: Role }

export type Access = {
  item: StorageItem
  canManage: boolean
  owner: StorageItem['owner']
  orgAccess: OrgAccess | null
  inheritedOrgAccess: { access: OrgAccess; from: PathEntry } | null
  /** The item's own public link (the token is the secret part of the URL). */
  publicLink: { token: string; createdAt: string; createdBy: string | null } | null
  /** A folder above has a public link, so this item can be opened from it. */
  inheritedPublicLink: { from: PathEntry } | null
  grants: Person[]
  inherited: (Person & { from: PathEntry; owner: boolean })[]
}

export type Member = { id: string; name: string | null; email: string; role: string }

/** One passage found by storage_search: a Storage file, a mail attachment or a message. */
export type SearchResult = {
  where: 'storage' | 'mail' | 'email'
  id: string
  score: number
  passage: string
  pos: number
  /** The file's name, or the email's subject. */
  name: string
  fileId?: string
  emailId?: string | null
  itemId?: string
  version?: number
  path?: PathEntry[]
  mailbox?: { id: string; address: string }
  threadId?: string | null
  from?: string
  receivedAt?: string
  /** Emails: inbox, sent, drafts, archive, junk or trash. */
  folder?: string | null
}

export const RANK: Record<Role, number> = { viewer: 1, editor: 2, manager: 3 }
export const canEdit = (item: { role: Role }) => RANK[item.role] >= RANK.editor

const enc = encodeURIComponent

export const storageApi = {
  top: async (orgId: string, view: TopView) =>
    (await api<{ items: StorageItem[] }>('GET', `/storage/orgs/${orgId}/items?view=${view}`)).items,

  folder: (folderId: string) =>
    api<{ folder: StorageItem; path: PathEntry[]; items: StorageItem[] }>('GET', `/storage/folders/${enc(folderId)}`),

  item: (itemId: string) =>
    api<{ item: StorageItem; path: PathEntry[]; trashed: boolean }>('GET', `/storage/items/${enc(itemId)}`),

  createFolder: async (orgId: string, name: string, where: { parentId?: string; space?: Space }) =>
    (await api<{ item: StorageItem }>('POST', `/storage/orgs/${orgId}/folders`, { name, ...where })).item,

  upload: async (orgId: string, file: File, where: { parentId?: string; space?: Space }) => {
    const params = new URLSearchParams({ name: file.name })
    if (where.parentId) params.set('parentId', where.parentId)
    else if (where.space) params.set('space', where.space)
    return (await api<{ item: StorageItem }>('POST', `/storage/orgs/${orgId}/files?${params}`, undefined, { file })).item
  },

  update: async (itemId: string, patch: { name?: string; parentId?: string | null; space?: Space }) =>
    (await api<{ item: StorageItem }>('PATCH', `/storage/items/${enc(itemId)}`, patch)).item,

  trash: (itemId: string) => api('POST', `/storage/items/${enc(itemId)}/trash`),
  restore: async (itemId: string) => (await api<{ item: StorageItem }>('POST', `/storage/items/${enc(itemId)}/restore`)).item,
  remove: (itemId: string) => api('DELETE', `/storage/items/${enc(itemId)}`),

  content: (itemId: string, version?: number) =>
    apiBlob(`/storage/items/${enc(itemId)}/content${version ? `?version=${version}` : ''}`),

  /** Saves new contents. `baseVersion` is the version the editor loaded; 409 version_conflict if it moved on. */
  save: async (item: StorageItem, baseVersion: number, data: Blob) => {
    const file = new File([data], item.name, { type: item.contentType ?? data.type ?? 'application/octet-stream' })
    return (await api<{ item: StorageItem }>('PUT', `/storage/items/${enc(item.id)}/content?baseVersion=${baseVersion}`, undefined, { file })).item
  },

  versions: async (itemId: string) => (await api<{ versions: Version[] }>('GET', `/storage/items/${enc(itemId)}/versions`)).versions,
  restoreVersion: async (itemId: string, version: number) =>
    (await api<{ item: StorageItem }>('POST', `/storage/items/${enc(itemId)}/versions/${version}/restore`)).item,

  access: (itemId: string) => api<Access>('GET', `/storage/items/${enc(itemId)}/access`),
  setAccess: (itemId: string, input: { orgAccess?: OrgAccess | null; grants?: { memberId: string; role: Role | null }[] }) =>
    api<Access>('PUT', `/storage/items/${enc(itemId)}/access`, input),
  setPublicLink: (itemId: string, enabled: boolean) => api<Access>('PUT', `/storage/items/${enc(itemId)}/public-link`, { enabled }),
  usage: (orgId: string) => api<Usage>('GET', `/storage/orgs/${orgId}/usage`),

  /** Search by meaning across files and mail (storage_search). 60 calls a minute; the API answers 429 beyond that. */
  search: async (orgId: string, q: { q: string; folderId?: string; limit?: number }) => {
    const params = new URLSearchParams({ q: q.q })
    if (q.folderId) params.set('folderId', q.folderId)
    if (q.limit) params.set('limit', String(q.limit))
    return (await api<{ results: SearchResult[] }>('GET', `/storage/orgs/${orgId}/search?${params}`)).results
  },
  members: async (orgId: string) => (await api<{ members: Member[] }>('GET', `/storage/orgs/${orgId}/members`)).members,

  attachments: (orgId: string, q: { mailboxId?: string; source?: 'received' | 'sent'; query?: string; cursor?: string }) => {
    const params = new URLSearchParams()
    for (const [k, v] of Object.entries(q)) if (v) params.set(k, v)
    return api<{ mailboxes: AttachmentMailbox[]; files: MailAttachment[]; nextCursor: string | null }>(
      'GET',
      `/storage/orgs/${orgId}/attachments?${params}`,
    )
  },
  attachment: (fileId: string) =>
    api<{ file: MailAttachment; mailbox: { id: string; address: string } }>('GET', `/storage/attachments/${enc(fileId)}`),
  attachmentContent: (fileId: string) => apiBlob(`/storage/attachments/${enc(fileId)}/content`),
  saveAttachment: async (fileId: string, where: { parentId?: string; space?: Space } = {}) =>
    (await api<{ item: StorageItem }>('POST', `/storage/attachments/${enc(fileId)}/save`, where)).item,
}

// ---------------------------------------------------------------------------------------------------------------
// Public links (the page at /s/, no sign-in)

export type PublicItem = { id: string; kind: 'folder' | 'file'; name: string; contentType: string | null; size: number; updatedAt: string }
export type PublicView = { organization: string | null; root: PublicItem; item: PublicItem; path: PathEntry[]; items: PublicItem[] }

/** The URL people outside the organization open. The token sits after #, so it never reaches a server log. */
export function publicLinkUrl(token: string): string {
  const base = desktop || !/^https?:/.test(location.origin) ? APP_ORIGIN : location.origin
  return `${base}/s/#${token}`
}

const contentPath = (token: string, itemId?: string) =>
  `/public/storage/${enc(token)}/content${itemId ? `?itemId=${enc(itemId)}` : ''}`

export const publicApi = {
  view: (token: string, itemId?: string) =>
    api<PublicView>('GET', `/public/storage/${enc(token)}${itemId ? `?folderId=${enc(itemId)}` : ''}`, undefined, { anonymous: true }),
  content: (token: string, itemId?: string) => apiBlob(contentPath(token, itemId), { anonymous: true }),
  /** A plain link: the API sends it as a download, so big files never load into the page. */
  downloadUrl: (token: string, itemId?: string) => apiUrl(contentPath(token, itemId)),
}

// ---------------------------------------------------------------------------------------------------------------
// File kinds

export type FileKind = 'folder' | 'csv' | 'markdown' | 'pdf' | 'image' | 'text' | 'other'

export function fileKind(name: string, contentType: string | null, kind: 'folder' | 'file' = 'file'): FileKind {
  if (kind === 'folder') return 'folder'
  const ext = name.toLowerCase().split('.').pop() ?? ''
  const type = (contentType ?? '').toLowerCase()
  if (ext === 'csv' || type === 'text/csv') return 'csv'
  if (ext === 'md' || ext === 'markdown' || type === 'text/markdown') return 'markdown'
  if (ext === 'pdf' || type === 'application/pdf') return 'pdf'
  // SVG is left out: it can carry scripts, and it isn't worth a sandbox for a preview.
  if (/^image\/(png|jpe?g|gif|webp)$/.test(type) || /^(png|jpe?g|gif|webp)$/.test(ext)) return 'image'
  if (type.startsWith('text/') || ext === 'txt' || ext === 'json') return 'text'
  return 'other'
}

/** Kinds Storage can edit in place (with editor access). */
export const EDITABLE: FileKind[] = ['csv', 'markdown', 'pdf']

/** Saves a blob through a temporary link, the same way the mail reader downloads attachments. */
export function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const link = Object.assign(document.createElement('a'), { href: url, download: name })
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
