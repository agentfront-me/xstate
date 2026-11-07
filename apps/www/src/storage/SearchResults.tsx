// Search by meaning across files and mail (storage_search): the field in the Storage header, and the results that
// replace the file list while a query is in the URL (#/storage?q=…). A result opens where the thing lives: a
// Storage file in the preview window, an attachment likewise, an email on the Email page.

import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { Icon } from '../components/Icon'
import { ApiError, errorMessage } from '../lib/core'
import { showMessage } from '../mail/MailPage'
import { formatTime } from '../mail/format'
import { type SearchResult, storageApi } from './api'
import { FileIcon } from './FileIcon'
import type { StorageSearch } from './StoragePage'
import { storageKeys } from './StoragePage'

const LIMIT = 20
/** Characters of passage shown around the first matching word. */
const WINDOW = 260
/** Typing pauses this long before a search runs; Enter runs it at once. */
const DEBOUNCE_MS = 600

/** The header field. The query lives in the URL, so back returns to the results and a link to them can be shared. */
export function SearchField({ search, go, autoFocus }: { search: StorageSearch; go: (s: StorageSearch, replace?: boolean) => void; autoFocus?: boolean }) {
  const [text, setText] = useState(search.q ?? '')
  const typed = useRef(false)
  useEffect(() => setText(search.q ?? ''), [search.q])

  const run = (q: string, replace: boolean) => {
    const trimmed = q.trim()
    if (trimmed === (search.q ?? '')) return
    go(trimmed ? { ...search, q: trimmed, open: undefined, att: undefined } : { view: search.view, folder: search.folder, mailbox: search.mailbox }, replace)
  }
  useEffect(() => {
    if (!typed.current) return
    const t = setTimeout(() => text.trim().length >= 3 && run(text, true), DEBOUNCE_MS)
    return () => clearTimeout(t)
    // Only typing should schedule a search.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text])

  return (
    <label className="s-search">
      <Icon name="search" size={14} />
      <input
        type="search"
        placeholder="Search files and mail"
        aria-label="Search files and mail by meaning"
        autoComplete="off"
        autoFocus={autoFocus}
        value={text}
        onChange={(e) => { typed.current = true; setText(e.target.value) }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') run(text, false)
          if (e.key === 'Escape') { setText(''); run('', false) }
        }}
      />
    </label>
  )
}

export function SearchResults({ orgId, search, go }: { orgId: string; search: StorageSearch; go: (s: StorageSearch, replace?: boolean) => void }) {
  const navigate = useNavigate()
  const q = search.q ?? ''
  const results = useQuery({
    queryKey: [...storageKeys.all, 'search', q, search.folder ?? ''],
    queryFn: () => storageApi.search(orgId, { q, folderId: search.folder, limit: LIMIT }),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    retry: false,
  })
  const folder = useQuery({
    queryKey: [...storageKeys.all, 'item', search.folder],
    queryFn: () => storageApi.item(search.folder!),
    enabled: !!search.folder,
    staleTime: 60_000,
  })
  const list = results.data ?? []
  const count = results.data ? `${list.length}${list.length === LIMIT ? '+' : ''} ${list.length === 1 ? 'result' : 'results'}` : ''

  const open = (r: SearchResult) => {
    if (r.where === 'storage' && r.itemId) go({ ...search, open: r.itemId })
    else if (r.where === 'mail' && r.fileId) go({ ...search, att: r.fileId })
    else if (r.where === 'email' && r.mailbox && r.emailId) {
      showMessage(r.mailbox.id, r.emailId, r.name, r.folder)
      void navigate({ to: '/mail' })
    }
  }

  return (
    <section className="s-main">
      <div className="col-head drag s-head">
        <div className="grow s-head-text">
          <nav className="crumbs" aria-label="Path">
            <button className="crumb" onClick={() => go({ view: search.view, folder: search.folder })}>{search.folder && folder.data ? folder.data.item.name : 'Storage'}</button>
            <span className="crumb-wrap"><Icon name="chevron-right" size={12} /><span className="crumb" aria-current="page">Search</span></span>
          </nav>
          {results.data && <span className="sub ellipsis">{count}{results.isFetching ? ' · updating' : ''}</span>}
        </div>
        {search.folder && (
          <button className="btn btn-sm" title="Search all your files and mail" onClick={() => go({ ...search, folder: undefined })}>
            <Icon name="x" size={14} />Only this folder
          </button>
        )}
        <SearchField search={search} go={go} autoFocus />
      </div>
      <div className="s-scroll">
        {results.isPending ? (
          <div className="loading"><span className="spinner" /></div>
        ) : results.isError ? (
          <div className="empty">
            <Icon name="circle-alert" size={24} />
            <strong>{results.error instanceof ApiError && results.error.status === 429 ? 'Too many searches in a minute' : "Couldn't search"}</strong>
            <span>{results.error instanceof ApiError && results.error.status === 429 ? 'Searches are limited to 60 a minute. Try again shortly.' : errorMessage(results.error)}</span>
            <button className="btn" onClick={() => void results.refetch()}>Try again</button>
          </div>
        ) : (
          <div className="s-table sr-list" role="list" aria-label="Search results">
            {list.map((r) => (
              <div key={r.id} role="listitem" tabIndex={0} className="sr-row" onClick={() => open(r)} onKeyDown={(e) => e.key === 'Enter' && open(r)}>
                <span className="sr-icon">
                  {r.where === 'email' ? <span className="file-icon"><Icon name="inbox" size={18} /></span> : <FileIcon name={r.name} contentType={null} kind="file" />}
                </span>
                <span className="sr-text">
                  <span className="sr-head">
                    <span className="sr-name ellipsis">{r.name || (r.where === 'email' ? '(no subject)' : 'Untitled')}</span>
                    <span className="sr-where ellipsis">{whereOf(r)}</span>
                  </span>
                  <span className="sr-passage">{highlight(snippet(r), q)}</span>
                </span>
                <span className="sr-date muted num">{r.receivedAt ? formatTime(r.receivedAt) : ''}</span>
              </div>
            ))}
            {!list.length && (
              <div className="s-empty">
                <span>Nothing found for “{q}”{search.folder ? ' in this folder' : ''}.</span>
                <span className="dim small">Search looks for meaning, not exact words: try describing what the file or message says.</span>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  )
}

/** Where a result lives: the folders above a file, or the mailbox and sender of a message or attachment. */
function whereOf(r: SearchResult): string {
  if (r.where === 'storage') return r.path?.length ? r.path.map((p) => p.name).join(' › ') : 'My Files'
  const mailbox = r.mailbox?.address ?? ''
  if (r.where === 'email') return r.from ? `${r.from} · ${mailbox}` : mailbox
  return `Attachment · ${mailbox}`
}

/** The passage on one line, without an email's header lines; highlight() then cuts it to a window. */
function snippet(r: SearchResult): string {
  let text = r.passage
  if (r.where === 'email' && r.pos === 0) {
    const body = text.indexOf('\n\n')
    if (body > 0) text = text.slice(body)
  }
  // PDFs arrive as Markdown with a heading per page; the markers mean nothing here.
  return text.replace(/^#{1,6}\s+/gm, '').replace(/\s+/g, ' ').trim()
}

/** Words that say nothing about what is being looked for, so they aren't marked in passages. */
const NOISE = new Set(
  'the and for with what does how are was were per this that from into about when where which who why can will has have had not you your its our they them their there here any all some much many more most'.split(' '),
)

/** Words of the query worth marking: three letters or more, and not noise. */
function terms(q: string): string[] {
  return [...new Set((q.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((w) => !NOISE.has(w)))]
}

/** Marks the query's words in the text, and cuts the text to a window around the first one. */
function highlight(text: string, q: string): ReactNode {
  const words = terms(q)
  if (!words.length) return cut(text, 0)
  const re = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'giu')
  const first = text.search(re)
  const shown = cut(text, first < 0 ? 0 : first)
  const parts = shown.split(re)
  return parts.map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : part))
}

/** At most WINDOW characters, starting a little before `around`, with ellipses where it was cut. */
function cut(text: string, around: number): string {
  if (text.length <= WINDOW) return text
  const start = Math.max(0, Math.min(around - 60, text.length - WINDOW))
  const end = Math.min(text.length, start + WINDOW)
  return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`
}
