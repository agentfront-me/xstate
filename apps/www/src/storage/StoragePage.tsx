// Storage: My Files, Shared with me, Team folders, Mail Attachments and Trash, from the storage_* API (api.ts).
// Layout follows the Storage screen of the "xstate App" design: sections on the left with their size and a usage
// bar, the current folder's files in a table, and files opening in a preview window (FileView) on top.
// Where you are lives in the URL (#/storage?view=…&folder=…&open=…), so back and forward work.

import '../styles/storage.css'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { type DragEvent, type MouseEvent, useEffect, useRef, useState } from 'react'
import { Icon, type IconName } from '../components/Icon'
import { toast } from '../components/Toast'
import { useAccount } from '../lib/account'
import { errorMessage } from '../lib/core'
import { formatSize, formatTime } from '../mail/format'
import { type PathEntry, type Space, type StorageItem, type TopView, canEdit, fileKind, saveBlob, storageApi } from './api'
import { FileIcon } from './FileIcon'
import { FileView } from './FileView'
import { ConfirmDialog, Menu, type MenuItem, MoveDialog, NameDialog, ShareDialog, VersionsDialog } from './dialogs'
import { SearchField, SearchResults } from './SearchResults'

export type StorageView = TopView | 'attachments'
export type StorageSearch = {
  view?: StorageView
  folder?: string
  mailbox?: string
  source?: 'received' | 'sent'
  /** A Storage item open in the preview window. */
  open?: string
  /** A mail attachment open in the preview window. */
  att?: string
  /** A search by meaning (SearchResults) in place of the file list. */
  q?: string
}

const VIEWS: { id: StorageView; label: string; icon: IconName }[] = [
  { id: 'personal', label: 'My Files', icon: 'hard-drive' },
  { id: 'shared', label: 'Shared with me', icon: 'users' },
  { id: 'organization', label: 'Team folders', icon: 'building-2' },
  { id: 'attachments', label: 'Mail Attachments', icon: 'paperclip' },
  { id: 'trash', label: 'Trash', icon: 'trash' },
]

export const storageKeys = { all: ['storage'] as const }

/** Something the sidebar's + menu asks the file list to start. */
type CreateRequest = { kind: 'folder' | 'md' | 'csv' | 'upload'; at: number }

export function StoragePage({ search }: { search: StorageSearch }) {
  const account = useAccount()
  if (account.mode === 'demo') {
    return (
      <section className="soon">
        <div className="col-head drag"><span className="title">Storage</span></div>
        <div className="empty">
          <Icon name="hard-drive" size={28} />
          <strong>Storage needs a signed-in account</strong>
          <span>Sign in to keep files, share them with your team and see your mail attachments.</span>
        </div>
      </section>
    )
  }
  return <Storage orgId={account.org.id} memberId={account.org.memberId ?? ''} search={search} />
}

function Storage({ orgId, memberId, search }: { orgId: string; memberId: string; search: StorageSearch }) {
  const navigate = useNavigate()
  const view: StorageView = search.view ?? 'personal'
  const go = (next: StorageSearch, replace = false) => void navigate({ to: '/storage', search: next, replace })
  // The file list and the attachments list keep the search state in the URL too; `go` is passed down as is.
  const [request, setRequest] = useState<CreateRequest | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)

  // The + menu adds to the folder you're in, or to My Files from views you can't add to.
  const create = (kind: CreateRequest['kind']) => {
    if (view !== 'personal' && view !== 'organization') go({ view: 'personal' })
    setRequest({ kind, at: Date.now() })
  }

  return (
    <div className="storage">
      <Sidebar
        orgId={orgId}
        view={view}
        search={search}
        go={go}
        onAdd={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          setMenu({ x: r.left, y: r.bottom + 4 })
        }}
      />
      {search.q ? (
        <SearchResults orgId={orgId} search={search} go={go} />
      ) : view === 'attachments' ? (
        <AttachmentList orgId={orgId} search={search} go={go} />
      ) : (
        <ItemList orgId={orgId} memberId={memberId} view={view} folderId={search.folder} search={search} go={go} request={request} />
      )}
      {search.open ? (
        <FileView key={search.open} orgId={orgId} target={{ kind: 'item', id: search.open }} onClose={() => go({ ...search, open: undefined })} go={go} />
      ) : search.att ? (
        <FileView key={search.att} orgId={orgId} target={{ kind: 'attachment', id: search.att }} onClose={() => go({ ...search, att: undefined })} go={go} />
      ) : null}
      {menu && (
        <Menu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { icon: 'folder-plus', label: 'New folder', run: () => create('folder') },
            { icon: 'file-text', label: 'New Markdown file', run: () => create('md') },
            { icon: 'file-spreadsheet', label: 'New CSV file', run: () => create('csv') },
            { icon: 'upload', label: 'Upload files', run: () => create('upload') },
          ]}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Sidebar

function Sidebar({
  orgId,
  view,
  search,
  go,
  onAdd,
}: {
  orgId: string
  view: StorageView
  search: StorageSearch
  go: (s: StorageSearch) => void
  onAdd: (e: MouseEvent<HTMLButtonElement>) => void
}) {
  const usage = useQuery({ queryKey: [...storageKeys.all, 'usage'], queryFn: () => storageApi.usage(orgId) })
  const u = usage.data
  // One figure beside each name, as in the design: size, or for Trash how many items wait there.
  const meta: Record<StorageView, string> = {
    personal: u ? formatSize(u.personal.bytes) : '',
    shared: '',
    organization: u ? formatSize(u.organization.bytes) : '',
    attachments: u ? formatSize(u.attachments.bytes) : '',
    trash: u && u.trash.items ? `${u.trash.items.toLocaleString()} ${u.trash.items === 1 ? 'item' : 'items'}` : '',
  }
  const segments = u
    ? [
        { label: 'My Files', bytes: u.personal.bytes, cls: 'is-personal' },
        { label: 'Team folders', bytes: u.organization.bytes, cls: 'is-team' },
        { label: 'Mail Attachments', bytes: u.attachments.bytes, cls: 'is-mail' },
      ]
    : []
  const total = segments.reduce((n, s) => n + s.bytes, 0)

  return (
    <aside className="s-side" aria-label="Storage">
      <div className="col-head drag s-side-head">
        <span className="title grow">Storage</span>
        <button className="ghost" title="New" aria-label="New" onClick={onAdd}><Icon name="plus" size={16} /></button>
      </div>
      <nav className="s-sections">
        {VIEWS.map((v) => (
          <div key={v.id}>
            <button className="s-section" aria-current={view === v.id && !search.mailbox ? 'true' : undefined} onClick={() => go({ view: v.id })}>
              <span className="s-tile"><Icon name={v.icon} size={15} /></span>
              <span className="s-section-name">{v.label}</span>
              {meta[v.id] && <span className="s-section-meta">{meta[v.id]}</span>}
            </button>
            {v.id === 'attachments' && view === 'attachments' && <MailboxFolders orgId={orgId} search={search} go={go} />}
          </div>
        ))}
      </nav>
      {u && (
        <div className="s-usage">
          <div className="s-usage-line">
            <span className="hi">{formatSize(total)}</span>
            <span>used</span>
          </div>
          <div className="s-usage-bar" role="img" aria-label={segments.map((s) => `${s.label} ${formatSize(s.bytes)}`).join(', ')}>
            {total > 0 && segments.map((s) => s.bytes > 0 && (
              <span key={s.label} className={s.cls} style={{ width: `${(s.bytes / total) * 100}%` }} title={`${s.label} · ${formatSize(s.bytes)}`} />
            ))}
          </div>
        </div>
      )}
    </aside>
  )
}

function MailboxFolders({ orgId, search, go }: { orgId: string; search: StorageSearch; go: (s: StorageSearch) => void }) {
  const { data } = useQuery({
    queryKey: [...storageKeys.all, 'attachment-mailboxes'],
    queryFn: async () => (await storageApi.attachments(orgId, {})).mailboxes,
  })
  return (
    <div className="s-subsections">
      {(data ?? []).map((m) => (
        <button key={m.id} className="s-subsection" aria-current={search.mailbox === m.id ? 'true' : undefined} onClick={() => go({ view: 'attachments', mailbox: m.id })} title={m.address}>
          <span className="ellipsis">{m.address}</span>
          {m.count > 0 && <span className="dim small">{m.count}</span>}
        </button>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Files and folders

type Dialog =
  | { kind: 'new-folder' }
  | { kind: 'new-file'; ext: 'md' | 'csv' }
  | { kind: 'rename'; item: StorageItem }
  | { kind: 'share'; item: StorageItem }
  | { kind: 'versions'; item: StorageItem }
  | { kind: 'move'; item: StorageItem }
  | { kind: 'delete'; item: StorageItem }

const TRASH_DAYS = 30

function ItemList({
  orgId,
  memberId,
  view,
  folderId,
  search,
  go,
  request,
}: {
  orgId: string
  memberId: string
  view: TopView
  folderId?: string
  search: StorageSearch
  go: (s: StorageSearch, replace?: boolean) => void
  request: CreateRequest | null
}) {
  const client = useQueryClient()
  const fileInput = useRef<HTMLInputElement>(null)
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const [uploading, setUploading] = useState(0)
  const [dragging, setDragging] = useState(false)

  const query = useQuery({
    queryKey: [...storageKeys.all, folderId ? 'folder' : 'top', folderId ?? view],
    queryFn: async () => {
      if (folderId) return storageApi.folder(folderId)
      return { folder: null, path: [] as PathEntry[], items: await storageApi.top(orgId, view) }
    },
  })
  const folder = query.data?.folder ?? null
  const items = query.data?.items ?? []
  const refresh = () => client.invalidateQueries({ queryKey: storageKeys.all })

  // Where new things go: this folder, or the top of My Files / team folders.
  const where: { parentId?: string; space?: Space } | null = folder
    ? canEdit(folder) ? { parentId: folder.id } : null
    : view === 'personal' ? { space: 'personal' } : view === 'organization' ? { space: 'organization' } : null

  // The sidebar's + menu.
  useEffect(() => {
    if (!request || !where) return
    if (request.kind === 'folder') setDialog({ kind: 'new-folder' })
    else if (request.kind === 'upload') fileInput.current?.click()
    else setDialog({ kind: 'new-file', ext: request.kind })
    // Only a new request should open anything.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.at])

  const upload = async (files: FileList | File[]) => {
    if (!where) return
    const list = [...files]
    setUploading((n) => n + list.length)
    let done = 0
    for (const file of list) {
      try {
        if (file.size > 100 * 1024 * 1024) throw new Error(`${file.name} is larger than 100 MB`)
        await storageApi.upload(orgId, file, where)
        done++
      } catch (err) {
        toast(errorMessage(err))
      } finally {
        setUploading((n) => n - 1)
      }
    }
    void refresh()
    if (done) toast(done === 1 ? `Uploaded ${list[0]!.name}` : `Uploaded ${done} files`)
  }

  const open = (item: StorageItem) => {
    if (view === 'trash') return
    if (item.kind === 'folder') go({ view, folder: item.id })
    else go({ view, folder: folderId, open: item.id })
  }

  const run = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn()
      void refresh()
      if (label) toast(label)
    } catch (err) {
      toast(errorMessage(err))
    }
  }

  const menuFor = (item: StorageItem): MenuItem[] => {
    if (view === 'trash') {
      return [
        { icon: 'rotate-ccw', label: 'Restore', run: () => run(`Restored ${item.name}`, () => storageApi.restore(item.id)) },
        ...(item.role === 'manager' ? [{ icon: 'trash' as const, label: 'Delete forever', run: () => setDialog({ kind: 'delete', item }) }] : []),
      ]
    }
    const edit = canEdit(item)
    return [
      { icon: item.kind === 'folder' ? 'folder-open' : 'file-text', label: 'Open', run: () => open(item) },
      { icon: 'user-plus', label: item.role === 'manager' ? 'Share' : 'Who has access', run: () => setDialog({ kind: 'share', item }) },
      ...(item.kind === 'file' ? [{ icon: 'download' as const, label: 'Download', run: () => run('', async () => saveBlob(await storageApi.content(item.id), item.name)) }] : []),
      ...(item.kind === 'file' ? [{ icon: 'history' as const, label: 'Versions', run: () => setDialog({ kind: 'versions', item }) }] : []),
      ...(edit ? [{ icon: 'square-pen' as const, label: 'Rename', run: () => setDialog({ kind: 'rename', item }) }] : []),
      ...(edit ? [{ icon: 'folder-input' as const, label: 'Move to…', run: () => setDialog({ kind: 'move', item }) }] : []),
      ...(edit ? [{ icon: 'trash' as const, label: 'Move to trash', run: () => run(`Moved ${item.name} to the trash`, () => storageApi.trash(item.id)) }] : []),
    ]
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setDragging(false)
    if (e.dataTransfer.files.length) void upload(e.dataTransfer.files)
  }

  const title = VIEWS.find((v) => v.id === view)?.label ?? 'Storage'
  const path = query.data?.path ?? []
  const totalSize = items.reduce((n, i) => n + (i.kind === 'file' ? i.size : 0), 0)
  const count = `${items.length.toLocaleString()} ${items.length === 1 ? 'item' : 'items'}`
  // Beside the title, as in the design: the size where it's known (a view's total from the usage figures), else how
  // many items. Folder sizes aren't totalled across subfolders, so folders show their item count.
  const usage = useQuery({ queryKey: [...storageKeys.all, 'usage'], queryFn: () => storageApi.usage(orgId) })
  const headMeta = folder
    ? count
    : view === 'personal' && usage.data ? formatSize(usage.data.personal.bytes)
      : view === 'organization' && usage.data ? formatSize(usage.data.organization.bytes)
        : view === 'trash' ? `${count} · deleted for good after ${TRASH_DAYS} days`
          : count

  return (
    <section
      className={`s-main${dragging ? ' is-dragging' : ''}`}
      onDragOver={(e) => {
        if (!where || !e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
      onDrop={onDrop}
    >
      <div className="col-head drag s-head">
        <div className="grow s-head-text">
          <nav className="crumbs" aria-label="Path">
            {path.length ? (
              <>
                <button className="crumb" onClick={() => go({ view })}>{title}</button>
                {path.map((p) => (
                  <span key={p.id} className="crumb-wrap">
                    <Icon name="chevron-right" size={12} />
                    <button className="crumb" aria-current={p.id === folderId ? 'page' : undefined} onClick={() => go({ view, folder: p.id })}>{p.name}</button>
                  </span>
                ))}
              </>
            ) : (
              <span className="crumb" aria-current="page">{title}</span>
            )}
          </nav>
          {query.data && <span className="sub ellipsis">{headMeta}</span>}
        </div>
        {uploading > 0 && <span className="muted small row-gap"><span className="spinner" />Uploading {uploading}…</span>}
        {view !== 'trash' && <SearchField search={search} go={go} />}
        {folder && (
          <button className="btn btn-sm" onClick={() => setDialog({ kind: 'share', item: folder })}>
            <Icon name="user-plus" size={14} />{folder.role === 'manager' ? 'Share' : 'Access'}
          </button>
        )}
        {where && (
          <>
            <button className="btn btn-sm" onClick={() => setDialog({ kind: 'new-folder' })}><Icon name="folder-plus" size={14} />New folder</button>
            <button className="btn btn-sm btn-primary" onClick={() => fileInput.current?.click()}><Icon name="upload" size={14} />Upload</button>
          </>
        )}
        <input ref={fileInput} type="file" multiple hidden onChange={(e) => { if (e.target.files) void upload(e.target.files); e.target.value = '' }} />
      </div>

      <div className="s-scroll">
        {query.isPending ? (
          <div className="loading"><span className="spinner" /></div>
        ) : query.isError ? (
          <div className="empty">
            <Icon name="circle-alert" size={24} />
            <strong>Couldn't load this folder</strong>
            <span>{errorMessage(query.error)}</span>
            <button className="btn" onClick={() => void query.refetch()}>Try again</button>
          </div>
        ) : (
          <div className="s-table" role="table" aria-label={folder?.name ?? title}>
            <div className="s-row s-row-head" role="row">
              <span role="columnheader">Name</span>
              <span role="columnheader">Source</span>
              <span role="columnheader">{view === 'trash' ? 'Deleted' : 'Access'}</span>
              <span role="columnheader" className="num">Size</span>
              <span role="columnheader" className="num">Modified</span>
              <span />
            </div>
            {items.map((item) => {
              const a = view === 'trash' ? null : accessOf(item, folder, memberId)
              return (
                <div
                  key={item.id}
                  role="row"
                  tabIndex={0}
                  className={`s-row${view === 'trash' ? ' is-trash' : ''}`}
                  onClick={() => open(item)}
                  onKeyDown={(e) => e.key === 'Enter' && open(item)}
                  onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, items: menuFor(item) }) }}
                >
                  <span className="s-name" role="cell">
                    <FileIcon name={item.name} contentType={item.contentType} kind={item.kind} />
                    <span className="ellipsis">{item.name}</span>
                    {item.role === 'viewer' && view !== 'trash' && <span className="tag">View only</span>}
                  </span>
                  <span className="muted ellipsis" role="cell">{item.owner ? (item.owner.memberId === memberId ? 'You' : item.owner.name || item.owner.email) : '—'}</span>
                  {a ? (
                    <span className={`s-access${a.strong ? ' is-strong' : ''}`} role="cell"><Icon name={a.icon} size={13} /><span className="ellipsis">{a.label}</span></span>
                  ) : (
                    <span className="s-access" role="cell" title={item.trashedAt ? new Date(item.trashedAt).toLocaleString() : ''}>
                      <Icon name="clock" size={13} /><span className="ellipsis">{formatTime(item.trashedAt ?? item.updatedAt)} · gone {formatTime(purgeDate(item.trashedAt))}</span>
                    </span>
                  )}
                  <span className="muted num" role="cell">{item.kind === 'file' ? formatSize(item.size) : '—'}</span>
                  <span className="muted num" role="cell" title={new Date(item.updatedAt).toLocaleString()}>{formatTime(item.updatedAt)}</span>
                  <span className="s-actions" role="cell">
                    {view !== 'trash' && (
                      <button className="ghost" title="Share" aria-label={`Share ${item.name}`} onClick={(e) => { e.stopPropagation(); setDialog({ kind: 'share', item }) }}>
                        <Icon name="user-plus" size={15} />
                      </button>
                    )}
                    <button className="ghost" aria-label={`More actions for ${item.name}`} onClick={(e) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); setMenu({ x: r.right - 220, y: r.bottom + 4, items: menuFor(item) }) }}>
                      <Icon name="ellipsis" size={15} />
                    </button>
                  </span>
                </div>
              )
            })}
            {!items.length && <EmptyFolder view={view} inFolder={!!folder} canAdd={!!where} onUpload={() => fileInput.current?.click()} />}
          </div>
        )}
      </div>

      {menu && <Menu {...menu} onClose={() => setMenu(null)} />}
      {dialog?.kind === 'new-folder' && where && (
        <NameDialog
          title="New folder"
          action="Create"
          initial="Untitled folder"
          onClose={() => setDialog(null)}
          onSubmit={async (name) => {
            await storageApi.createFolder(orgId, name, where)
            void refresh()
          }}
        />
      )}
      {dialog?.kind === 'new-file' && where && (
        <NameDialog
          title={dialog.ext === 'md' ? 'New Markdown file' : 'New CSV file'}
          action="Create"
          initial={dialog.ext === 'md' ? 'Untitled.md' : 'Untitled.csv'}
          selectUntil="."
          onClose={() => setDialog(null)}
          onSubmit={async (raw) => {
            const name = raw.toLowerCase().endsWith(`.${dialog.ext}`) ? raw : `${raw}.${dialog.ext}`
            const body = dialog.ext === 'md' ? '' : 'Column 1,Column 2,Column 3\n,,\n'
            const item = await storageApi.upload(orgId, new File([body], name, { type: dialog.ext === 'md' ? 'text/markdown' : 'text/csv' }), where)
            void refresh()
            go({ ...search, open: item.id })
          }}
        />
      )}
      {dialog?.kind === 'rename' && (
        <NameDialog
          title={`Rename ${dialog.item.kind}`}
          action="Rename"
          initial={dialog.item.name}
          selectUntil={dialog.item.kind === 'file' ? '.' : undefined}
          onClose={() => setDialog(null)}
          onSubmit={async (name) => {
            await storageApi.update(dialog.item.id, { name })
            void refresh()
          }}
        />
      )}
      {dialog?.kind === 'share' && <ShareDialog orgId={orgId} item={dialog.item} onClose={() => { setDialog(null); void refresh() }} />}
      {dialog?.kind === 'versions' && <VersionsDialog item={dialog.item} onClose={() => setDialog(null)} onRestored={() => void refresh()} />}
      {dialog?.kind === 'move' && (
        <MoveDialog
          orgId={orgId}
          item={dialog.item}
          onClose={() => setDialog(null)}
          onMoved={(to) => {
            void refresh()
            toast(`Moved ${dialog.item.name} to ${to}`)
          }}
        />
      )}
      {dialog?.kind === 'delete' && (
        <ConfirmDialog
          title={`Delete ${dialog.item.name} forever?`}
          body={dialog.item.kind === 'folder' ? 'Everything inside it is deleted too. This cannot be undone.' : 'This cannot be undone.'}
          action="Delete forever"
          onClose={() => setDialog(null)}
          onConfirm={() => run(`Deleted ${dialog.item.name}`, () => storageApi.remove(dialog.item.id))}
        />
      )}
    </section>
  )
}

const purgeDate = (trashedAt: string | null) =>
  new Date(Date.parse(trashedAt ?? new Date().toISOString()) + TRASH_DAYS * 86_400_000).toISOString()

/**
 * The Access column: what the item gives by itself, or what it gets from its folder ("· inherited"). Matches the
 * design's labels: "Only you", "2 people", "Organization".
 */
export function accessOf(item: StorageItem, folder: StorageItem | null, memberId: string): { icon: IconName; label: string; strong: boolean } {
  if (item.publicLink) return { icon: 'globe', label: 'Anyone with the link', strong: true }
  if (item.orgAccess) {
    return { icon: 'building-2', label: `Organization${item.orgAccess === 'editor' ? ' · can edit' : ''}${item.people ? ` + ${item.people}` : ''}`, strong: false }
  }
  if (item.people) return { icon: 'users', label: `${item.people} ${item.people === 1 ? 'person' : 'people'}`, strong: false }
  if (folder && (folder.publicLink || folder.orgAccess || folder.people)) {
    const from = accessOf(folder, null, memberId)
    return { ...from, label: `${from.label} · inherited` }
  }
  if (folder) return { icon: 'folder', label: 'Same as folder', strong: false }
  const mine = item.owner?.memberId === memberId
  return { icon: 'lock', label: mine ? 'Only you' : 'Private', strong: false }
}

function EmptyFolder({ view, inFolder, canAdd, onUpload }: { view: TopView; inFolder: boolean; canAdd: boolean; onUpload: () => void }) {
  const copy: Record<TopView, string> = {
    personal: 'Nothing in My Files yet. Only you can see what you put here, until you share it.',
    organization: 'No team folders yet. Everyone in your organization can see a new team folder; you choose who can edit.',
    shared: 'Nothing shared with you yet. Files and folders people share with you show up here.',
    trash: `Trash is empty. Deleted files stay here for ${TRASH_DAYS} days.`,
  }
  return (
    <div className="s-empty">
      <span>{inFolder ? 'No files in this folder.' : copy[view]}</span>
      {canAdd && (
        <button className="btn btn-sm" onClick={onUpload}><Icon name="upload" size={14} />Upload files</button>
      )}
    </div>
  )
}


// ---------------------------------------------------------------------------------------------------------------
// Mail Attachments

function AttachmentList({ orgId, search, go }: { orgId: string; search: StorageSearch; go: (s: StorageSearch) => void }) {
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), 250)
    return () => clearTimeout(t)
  }, [query])

  const filter = { mailboxId: search.mailbox, source: search.source, query: debounced }
  const list = useInfiniteQuery({
    queryKey: [...storageKeys.all, 'attachments', filter],
    queryFn: ({ pageParam }) => storageApi.attachments(orgId, { ...filter, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  })
  const files = list.data?.pages.flatMap((p) => p.files) ?? []
  const mailboxList = list.data?.pages[0]?.mailboxes ?? []
  const mailboxes = new Map(mailboxList.map((m) => [m.id, m]))
  const mailbox = search.mailbox ? mailboxes.get(search.mailbox) : null
  const scope = mailbox ? [mailbox] : mailboxList
  const bytes = scope.reduce((n, m) => n + m.bytes, 0)
  const count = scope.reduce((n, m) => n + m.count, 0)

  return (
    <section className="s-main">
      <div className="col-head drag s-head">
        <div className="grow s-head-text">
          <nav className="crumbs" aria-label="Path">
            {mailbox ? (
              <>
                <button className="crumb" onClick={() => go({ view: 'attachments' })}>Mail Attachments</button>
                <span className="crumb-wrap"><Icon name="chevron-right" size={12} /><span className="crumb" aria-current="page">{mailbox.address}</span></span>
              </>
            ) : (
              <span className="crumb" aria-current="page">Mail Attachments</span>
            )}
          </nav>
          {list.data && <span className="sub ellipsis" title={`${count.toLocaleString()} ${count === 1 ? 'file' : 'files'} · read-only; save a copy to My Files to edit`}>{formatSize(bytes)}</span>}
        </div>
        <div className="seg" role="group" aria-label="Direction">
          {([undefined, 'received', 'sent'] as const).map((s) => (
            <button key={s ?? 'all'} aria-pressed={search.source === s} onClick={() => go({ view: 'attachments', mailbox: search.mailbox, source: s })}>
              {s === 'received' ? 'Received' : s === 'sent' ? 'Sent' : 'All'}
            </button>
          ))}
        </div>
        <input className="text-input files-search" placeholder="Search names" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      <div className="s-scroll">
        {list.isPending ? (
          <div className="loading"><span className="spinner" /></div>
        ) : list.isError ? (
          <div className="empty"><Icon name="circle-alert" size={24} /><strong>Couldn't load attachments</strong><span>{errorMessage(list.error)}</span></div>
        ) : (
          <div className="s-table" role="table" aria-label="Mail Attachments">
            <div className="s-row s-row-head" role="row">
              <span role="columnheader">Name</span>
              <span role="columnheader">Source</span>
              <span role="columnheader">Access</span>
              <span role="columnheader" className="num">Size</span>
              <span role="columnheader" className="num">Received</span>
              <span />
            </div>
            {files.map((f) => {
              const m = mailboxes.get(f.mailboxId)
              const openIt = () => go({ ...search, att: f.id })
              return (
                <div key={f.id} role="row" tabIndex={0} className="s-row" onClick={openIt} onKeyDown={(e) => e.key === 'Enter' && openIt()}>
                  <span className="s-name" role="cell">
                    <FileIcon name={f.name} contentType={f.contentType} kind="file" />
                    <span className="ellipsis">{f.name}</span>
                  </span>
                  <span className="muted ellipsis" role="cell" title={m?.address}>{f.source === 'sent' ? 'Sent from ' : ''}{m?.address ?? ''}</span>
                  <span className="s-access" role="cell">
                    <Icon name={m?.kind === 'personal' ? 'lock' : 'users'} size={13} />
                    <span className="ellipsis">{m?.kind === 'personal' ? 'Only you' : 'People with mailbox access'}</span>
                  </span>
                  <span className="muted num" role="cell">{formatSize(f.size)}</span>
                  <span className="muted num" role="cell" title={new Date(f.createdAt).toLocaleString()}>{formatTime(f.createdAt)}</span>
                  <span />
                </div>
              )
            })}
            {!files.length && (
              <div className="s-empty">
                <span>{debounced ? 'No attachments match.' : 'No attachments yet. Files sent and received in the mailboxes you can read appear here.'}</span>
              </div>
            )}
          </div>
        )}
        {list.hasNextPage && (
          <div className="more-row">
            <button className="btn" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
              {list.isFetchingNextPage ? <span className="spinner" /> : null}Load more
            </button>
          </div>
        )}
      </div>
    </section>
  )
}
