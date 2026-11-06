// Email: folders and domains, the conversation list, and the reader. Mail comes from source.ts (the email_* API
// when signed in, sample data in demo mode) through the React Query cache (data.tsx).

import { type InfiniteData, useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon, type IconName } from '../components/Icon'
import { toast } from '../components/Toast'
import { useAccount } from '../lib/account'
import { errorMessage } from '../lib/core'
import type { Domain, FolderView, MailboxFolders, Message, MessageSummary } from '../lib/types'
import { Composer } from './Composer'
import { adjustUnread, keyOf, patchRow, reloadFolders, reloadLists, useFolders, useMailSource, useUnreadCount } from './data'
import { formatTime, sender } from './format'
import { useMailIntent } from './intents'
import { Reader } from './Reader'
import type { ListPage, Patch } from './source'

const FOLDERS: { id: FolderView; label: string; icon: IconName }[] = [
  { id: 'inbox', label: 'Inbox', icon: 'inbox' },
  { id: 'pinned', label: 'Pinned', icon: 'pin' },
  { id: 'sent', label: 'Sent', icon: 'send' },
  { id: 'drafts', label: 'Drafts', icon: 'file-pen' },
  { id: 'archive', label: 'Archive', icon: 'archive' },
  { id: 'junk', label: 'Spam', icon: 'shield-alert' },
]

/** null for all inboxes, or one domain, or one mailbox. */
type Scope = null | { domainId: string } | { mailboxId: string }
type View = { folder: FolderView; scope: Scope; unreadOnly: boolean; query: string; searching: boolean; selected: string | null }

/** What the Email page shows, kept across page switches. */
let remembered: View = { folder: 'inbox', scope: null, unreadOnly: false, query: '', searching: false, selected: null }

const domainName = (address: string) => address.split('@')[1] ?? ''
const NARROW = 680
const isNarrow = () => window.innerWidth <= NARROW

function useNarrow() {
  const [narrow, setNarrow] = useState(isNarrow)
  useEffect(() => {
    const onResize = () => setNarrow(isNarrow())
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return narrow
}

export function MailPage() {
  const account = useAccount()
  const source = useMailSource()
  const client = useQueryClient()
  const navigate = useNavigate()
  const narrow = useNarrow()
  const folders = useFolders()
  const mailboxes = folders.data ?? []
  const [view, setViewState] = useState<View>(remembered)
  const [composer, setComposer] = useState<{ forward: Message | null } | null>(null)
  const [debouncedQuery, setDebouncedQuery] = useState(view.query)

  useEffect(() => {
    remembered = view
  }, [view])
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(view.query), 300)
    return () => clearTimeout(t)
  }, [view.query])

  /** Changing what's listed starts over with nothing selected. */
  const setView = (changes: Partial<View>) => setViewState((v) => ({ ...v, ...changes, selected: null }))

  useMailIntent(
    useCallback((intent) => {
      if (intent === 'compose') setComposer({ forward: null })
      if (intent === 'search') setViewState((v) => ({ ...v, searching: true }))
    }, []),
  )

  // Mailboxes in the current scope, or undefined for all.
  const scopeIds = useMemo(() => {
    const s = view.scope
    if (!s) return undefined
    if ('mailboxId' in s) return [s.mailboxId]
    const domain = account.domains.find((d) => d.id === s.domainId)
    return mailboxes.filter((mb) => domainName(mb.address) === domain?.name).map((mb) => mb.mailboxId)
  }, [view.scope, account.domains, mailboxes])

  const listKey = { folder: view.folder, scope: scopeIds ?? null, unreadOnly: view.unreadOnly, query: debouncedQuery }
  const list = useInfiniteQuery({
    queryKey: ['mail', 'list', listKey],
    // A domain with no readable mailboxes has nothing to show; the API takes one mailbox or all of them.
    queryFn: ({ pageParam }): Promise<ListPage> =>
      scopeIds && !scopeIds.length
        ? Promise.resolve({ messages: [], nextCursor: null })
        : source.list({
            folder: view.folder,
            mailboxId: scopeIds?.length === 1 ? scopeIds[0] : undefined,
            unreadOnly: view.unreadOnly,
            query: debouncedQuery,
            cursor: pageParam,
          }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: folders.isSuccess,
  })

  // One row per conversation. A long conversation can come back on a later page by an older message: keep the first.
  const rows = useMemo(() => {
    const seen = new Set<string>()
    return (list.data?.pages ?? [])
      .flatMap((p) => p.messages)
      .filter((m) => !scopeIds || scopeIds.includes(m.mailboxId))
      .filter((m) => {
        const thread = `${m.mailboxId}/${m.threadId}`
        if (seen.has(thread)) return false
        seen.add(thread)
        return true
      })
  }, [list.data, scopeIds])

  const selected = rows.find((m) => keyOf(m) === view.selected) ?? null

  // On wide screens something is always open: the newest conversation, until the person picks one.
  useEffect(() => {
    if (!list.isSuccess || selected) return
    const first = rows[0]
    setViewState((v) => ({ ...v, selected: !narrow && first ? keyOf(first) : null }))
  }, [list.isSuccess, rows, selected, narrow])

  // ------------------------------------------------------------------------------------------------------------
  // Changes

  const setSeen = useCallback(
    async (row: MessageSummary, seen: boolean) => {
      patchRow(client, row, { seen })
      adjustUnread(client, row, seen ? -1 : 1)
      try {
        await source.update(row, { seen })
        // The whole conversation changed, which may be more than one unread message; take counts from the server.
        if (row.threadSize > 1) void reloadFolders(client)
      } catch (err) {
        patchRow(client, row, { seen: !seen })
        adjustUnread(client, row, seen ? 1 : -1)
        toast(errorMessage(err))
      }
    },
    [client, source],
  )

  /** Pins, unpins or moves a conversation: updates the screen right away, and reloads if the server says no. */
  const change = useCallback(
    async (row: MessageSummary, patch: Patch, message: string, leavesList = false) => {
      patchRow(client, row, patch)
      if (leavesList && view.folder !== 'pinned' && patch.folder !== view.folder) {
        client.setQueriesData<InfiniteData<ListPage>>({ queryKey: ['mail', 'list'] }, (data) =>
          data && { ...data, pages: data.pages.map((p) => ({ ...p, messages: p.messages.filter((m) => keyOf(m) !== keyOf(row)) })) },
        )
      }
      try {
        await source.update(row, patch)
        toast(message)
        if (patch.folder) void reloadFolders(client)
      } catch (err) {
        toast(errorMessage(err))
        void reloadLists(client)
      }
    },
    [client, source, view.folder],
  )

  const open = (row: MessageSummary) => {
    setViewState((v) => ({ ...v, selected: keyOf(row) }))
    if (!row.seen) void setSeen(row, true)
  }

  const closeComposer = useCallback(() => setComposer(null), [])
  const sent = useCallback(() => {
    setComposer(null)
    toast('Sent')
    void reloadFolders(client)
    if (remembered.folder === 'sent') void reloadLists(client)
  }, [client])

  const ownAddress = (mailboxId: string) => mailboxes.find((mb) => mb.mailboxId === mailboxId)?.address ?? ''

  return (
    <section className={`mail${view.selected ? ' has-open' : ''}`}>
      <FolderNav
        view={view}
        domains={account.domains}
        mailboxes={mailboxes}
        onView={setView}
        onCompose={() => setComposer({ forward: null })}
        onAddDomain={() => void navigate({ to: '/settings/$section', params: { section: 'domains' } })}
      />
      <div className="list">
        <ListHead
          view={view}
          domains={account.domains}
          mailboxes={mailboxes}
          scopeCount={scopeIds?.length ?? 0}
          onUnread={(unreadOnly) => setView({ unreadOnly })}
          onQuery={(query) => setViewState((v) => ({ ...v, query }))}
          onCloseSearch={() => setView({ searching: false, query: '' })}
        />
        <div
          className="list-scroll"
          onScroll={(event) => {
            const r = event.currentTarget
            if (r.scrollTop + r.clientHeight > r.scrollHeight - 200 && list.hasNextPage && !list.isFetchingNextPage) void list.fetchNextPage()
          }}
        >
          <Rows
            rows={rows}
            selected={view.selected}
            loading={list.isPending || folders.isPending}
            error={folders.error?.message ?? list.error?.message ?? null}
            more={list.hasNextPage}
            loadingMore={list.isFetchingNextPage}
            empty={emptyText(view, mailboxes.length === 0, debouncedQuery, listTitle(view, account.domains, mailboxes, scopeIds?.length ?? 0).title)}
            onOpen={open}
            onRetry={() => void (folders.isError ? folders.refetch() : list.refetch())}
          />
        </div>
      </div>
      <div className="reader">
        {selected ? (
          <Reader
            key={keyOf(selected)}
            row={selected}
            source={source}
            ownAddress={ownAddress(selected.mailboxId)}
            narrow={narrow}
            onClose={() => setViewState((v) => ({ ...v, selected: null }))}
            onChange={(row, patch, message, leaves) => void change(row, patch, message, leaves)}
            onSeen={(row, seen) => void setSeen(row, seen)}
            onForward={(original) => setComposer({ forward: original })}
          />
        ) : (
          <>
            <div className="col-head drag" />
            <div className="empty">
              <Icon name="inbox" size={28} />
              <strong>No message selected</strong>
            </div>
          </>
        )}
      </div>
      {composer && <Composer source={source} mailboxes={mailboxes} forward={composer.forward} onClose={closeComposer} onSent={sent} />}
    </section>
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Folders and domains

type FolderNavProps = {
  view: View
  domains: Domain[]
  mailboxes: MailboxFolders[]
  onView: (changes: Partial<View>) => void
  onCompose: () => void
  onAddDomain: () => void
}

function FolderNav({ view, domains, mailboxes, onView, onCompose, onAddDomain }: FolderNavProps) {
  const unread = useUnreadCount()
  const all = !view.scope
  const count = (id: FolderView) => {
    const sum = (role: string, key: 'unread' | 'total') =>
      mailboxes.reduce((n, mb) => n + (mb.folders.find((f) => f.role === role)?.[key] ?? 0), 0)
    if (id === 'inbox') return sum('inbox', 'unread')
    if (id === 'drafts') return sum('drafts', 'total')
    return 0
  }
  const current = (scope: Scope) => JSON.stringify(view.scope) === JSON.stringify(scope)

  return (
    <nav className="folders" aria-label="Mail folders">
      <div className="drag">
        <button className="btn btn-primary btn-lg new-mail" onClick={onCompose}>
          <Icon name="pencil" size={15} />
          New mail
        </button>
      </div>
      {FOLDERS.map((f) => {
        const n = count(f.id)
        return (
          <button
            key={f.id}
            className="folder"
            aria-current={view.folder === f.id && all ? 'true' : undefined}
            onClick={() => onView({ folder: f.id, scope: null })}
          >
            <Icon name={f.icon} size={15} />
            <span className="label">{f.label}</span>
            {n > 0 && <span className="count">{n}</span>}
          </button>
        )
      })}
      <div className="section-label">
        <span>Domains</span>
        <button onClick={onAddDomain} aria-label="Add domain" title="Add domain">
          <Icon name="plus" size={14} />
        </button>
      </div>
      <button className="folder" aria-current={all && view.folder === 'inbox' ? 'true' : undefined} onClick={() => onView({ folder: 'inbox', scope: null })}>
        <Icon name="layers" size={15} />
        <span className="label">All inboxes</span>
        {unread > 0 && <span className="count">{unread}</span>}
      </button>
      {domains.map((d) => {
        const verified = d.status === 'verified'
        const boxes = mailboxes.filter((mb) => domainName(mb.address) === d.name)
        return (
          <div key={d.id} style={{ display: 'contents' }}>
            <button
              className="domain-row"
              aria-current={current({ domainId: d.id }) ? 'true' : undefined}
              title={d.name}
              onClick={() => onView({ folder: 'inbox', scope: { domainId: d.id } })}
            >
              <span className="badge">{d.name[0]?.toUpperCase()}</span>
              <span className="label ellipsis">{d.name}</span>
              <span className="state" title={verified ? 'Verified' : 'DNS records pending'}>
                <Icon name={verified ? 'circle-check' : 'info'} size={13} />
              </span>
            </button>
            {boxes.map((mb) => {
              const n = mb.folders.find((f) => f.role === 'inbox')?.unread ?? 0
              return (
                <button
                  key={mb.mailboxId}
                  className="folder addr"
                  aria-current={current({ mailboxId: mb.mailboxId }) ? 'true' : undefined}
                  title={mb.address}
                  onClick={() => onView({ folder: 'inbox', scope: { mailboxId: mb.mailboxId } })}
                >
                  <span className="label ellipsis">{mb.address.split('@')[0]}@</span>
                  {n > 0 && <span className="count">{n}</span>}
                </button>
              )
            })}
            {!verified && (
              <div className="pending-note">
                DNS records pending. <button onClick={onAddDomain}>Verify domain</button>
              </div>
            )}
          </div>
        )
      })}
      {!domains.length && (
        <div className="pending-note" style={{ paddingLeft: 10 }}>
          No domains yet. <button onClick={onAddDomain}>Add one</button>
        </div>
      )}
    </nav>
  )
}

// ---------------------------------------------------------------------------------------------------------------
// The list

function listTitle(view: View, domains: Domain[], mailboxes: MailboxFolders[], scopeCount: number) {
  const folder = FOLDERS.find((f) => f.id === view.folder)!.label
  const s = view.scope
  if (s && 'mailboxId' in s) return { title: mailboxes.find((mb) => mb.mailboxId === s.mailboxId)?.address ?? '', sub: folder }
  if (s) {
    const d = domains.find((x) => x.id === s.domainId)
    return { title: d?.name ?? '', sub: `${folder} · ${scopeCount} ${scopeCount === 1 ? 'address' : 'addresses'}` }
  }
  const n = domains.length
  return { title: folder, sub: `All inboxes · ${n} ${n === 1 ? 'domain' : 'domains'}` }
}

type ListHeadProps = {
  view: View
  domains: Domain[]
  mailboxes: MailboxFolders[]
  scopeCount: number
  onUnread: (unreadOnly: boolean) => void
  onQuery: (query: string) => void
  onCloseSearch: () => void
}

function ListHead({ view, domains, mailboxes, scopeCount, onUnread, onQuery, onCloseSearch }: ListHeadProps) {
  const { title, sub } = listTitle(view, domains, mailboxes, scopeCount)
  const search = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (view.searching) search.current?.focus()
  }, [view.searching])
  return (
    <>
      <div className="col-head list-head drag">
        <div className="grow">
          <div className="title ellipsis">{title}</div>
          <div className="sub ellipsis">{sub}</div>
        </div>
        <div className="seg" role="group" aria-label="Filter">
          <button aria-pressed={!view.unreadOnly} onClick={() => onUnread(false)}>
            All
          </button>
          <button aria-pressed={view.unreadOnly} onClick={() => onUnread(true)}>
            Unread
          </button>
        </div>
      </div>
      <div className="list-search" hidden={!view.searching}>
        <input
          ref={search}
          type="search"
          placeholder="Search mail"
          aria-label="Search mail"
          autoComplete="off"
          value={view.query}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onCloseSearch()
          }}
        />
      </div>
    </>
  )
}

function emptyText(view: View, noMailboxes: boolean, query: string, title: string) {
  const q = query.trim()
  if (q) return { icon: 'search' as const, title: 'No matches', sub: `Nothing in ${title} matches “${q}”.` }
  if (noMailboxes) return { icon: 'inbox' as const, title: 'No mailboxes yet', sub: 'Add an address in Settings › Domains to start getting mail.' }
  const sub = view.unreadOnly
    ? 'You have read everything.'
    : view.folder === 'inbox'
      ? 'Mail sent to your addresses will show up here.'
      : 'No messages in this folder.'
  return { icon: 'inbox' as const, title: 'Nothing here', sub }
}

type RowsProps = {
  rows: MessageSummary[]
  selected: string | null
  loading: boolean
  error: string | null
  more: boolean
  loadingMore: boolean
  empty: { icon: IconName; title: string; sub: string }
  onOpen: (row: MessageSummary) => void
  onRetry: () => void
}

function Rows({ rows, selected, loading, error, more, loadingMore, empty, onOpen, onRetry }: RowsProps) {
  if (loading && !rows.length) {
    return (
      <div className="empty" style={{ height: '100%' }}>
        <span className="spinner" />
      </div>
    )
  }
  if (error) {
    return (
      <div className="empty" style={{ height: '100%' }}>
        <Icon name="circle-alert" size={24} />
        <strong>Couldn't load mail</strong>
        <span className="small">{error}</span>
        <button className="btn" onClick={onRetry}>
          Try again
        </button>
      </div>
    )
  }
  if (!rows.length) {
    return (
      <div className="empty" style={{ height: '100%' }}>
        <Icon name={empty.icon} size={24} />
        <strong>{empty.title}</strong>
        <span className="small">{empty.sub}</span>
      </div>
    )
  }
  return (
    <>
      {rows.map((m) => {
        const who = m.folder === 'sent' ? `To ${m.to.map((a) => a.name || a.email).join(', ')}` : sender(m.from)
        return (
          <button key={keyOf(m)} className={`row${m.seen ? '' : ' is-unread'}`} aria-selected={keyOf(m) === selected} onClick={() => onOpen(m)}>
            <div className="row-top">
              <span className="who ellipsis">{who}</span>
              {m.threadSize > 1 && <span className="thread-count">{m.threadSize}</span>}
              <span className="meta">
                {m.hasAttachment && <Icon name="paperclip" size={12} />}
                {m.pinned && <Icon name="pin" size={12} />}
                {!m.seen && <span className="dot" aria-label="Unread" />}
                {formatTime(m.receivedAt)}
              </span>
            </div>
            <div className="subject ellipsis">{m.subject || '(no subject)'}</div>
            <div className="preview ellipsis">{m.preview}</div>
          </button>
        )
      })}
      {more && (
        <div className="empty small" style={{ padding: 14 }}>
          {loadingMore && <span className="spinner" />}
        </div>
      )}
    </>
  )
}
