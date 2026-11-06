// xstate.com/s/#<token>: a file or folder someone made public with "Anyone with the link". No sign-in, view and
// download only. Inside a shared folder, #<token>/<itemId> opens a subfolder or a file, so Back works.
//
// The token is in the fragment, so it never reaches a server log; the API checks it on every request.

import '../styles/dashboard.css'
import '../styles/storage.css'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { StrictMode, Suspense, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Icon } from '../components/Icon'
import { ApiError, applyTheme, errorMessage, themeChoice } from '../lib/core'
import { formatSize, formatTime } from '../mail/format'
import { type PublicItem, fileKind, publicApi } from './api'
import { FileBody } from './FileBody'
import { FileIcon } from './FileIcon'

applyTheme(themeChoice())

/** Files bigger than this aren't loaded into the page for a preview; they're a download. */
const MAX_PREVIEW_BYTES = 50 * 1024 * 1024
const PREVIEWABLE = new Set(['csv', 'markdown', 'pdf', 'image', 'text'])
const noop = () => {}

function parseHash(): { token: string; itemId?: string } {
  const [token = '', itemId] = decodeURIComponent(location.hash.slice(1)).split('/')
  return { token, itemId: itemId || undefined }
}

function useHash() {
  const [hash, setHash] = useState(parseHash)
  useEffect(() => {
    const on = () => setHash(parseHash())
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return hash
}

function PublicPage() {
  const { token, itemId } = useHash()
  const view = useQuery({
    queryKey: ['public', token, itemId ?? ''],
    queryFn: () => publicApi.view(token, itemId),
    enabled: !!token,
    retry: (n, err) => !(err instanceof ApiError && err.status < 500) && n < 2,
  })
  const go = (id: string | null) => {
    location.hash = id && id !== view.data?.root.id ? `${token}/${id}` : token
  }

  useEffect(() => {
    if (view.data) document.title = `${view.data.item.name} · xstate`
  }, [view.data])

  return (
    <div className="pub">
      <header className="pub-top">
        <a href="/" className="pub-brand" aria-label="xstate">
          <img src="/brand/logo.svg" alt="" width={24} height={24} />
          <span>xstate</span>
        </a>
        {view.data?.organization && <span className="dim small ellipsis">Shared from {view.data.organization}</span>}
      </header>

      <main className="pub-main">
        {!token || view.isError ? (
          <Gone message={view.error instanceof ApiError && view.error.status === 404 ? null : view.error ? errorMessage(view.error) : null} />
        ) : view.isPending ? (
          <div className="loading"><span className="spinner" /></div>
        ) : (
          <>
            <div className="pub-head">
              <FileIcon name={view.data.item.name} contentType={view.data.item.contentType} kind={view.data.item.kind} bare />
              <div className="grow s-head-text">
                {view.data.path.length > 1 ? (
                  <nav className="crumbs" aria-label="Folder path">
                    {view.data.path.map((p, i) => {
                      const last = i === view.data.path.length - 1
                      return (
                        <span key={p.id} className="crumb-wrap">
                          {i > 0 && <Icon name="chevron-right" size={13} />}
                          {last ? (
                            <span className="crumb" aria-current="page">{p.name}</span>
                          ) : (
                            <button className="crumb" onClick={() => go(p.id)}>{p.name}</button>
                          )}
                        </span>
                      )
                    })}
                  </nav>
                ) : (
                  <span className="hi ellipsis">{view.data.item.name}</span>
                )}
                <span className="sub">{meta(view.data.item, view.data.items.length)}</span>
              </div>
              {view.data.item.kind === 'file' && (
                <a className="btn btn-sm btn-primary" href={publicApi.downloadUrl(token, itemId)} download={view.data.item.name}>
                  <Icon name="download" size={14} />Download
                </a>
              )}
            </div>

            {view.data.item.kind === 'folder' ? (
              <FolderList token={token} items={view.data.items} onOpen={(i) => go(i.id)} />
            ) : (
              <FilePreview token={token} itemId={itemId} item={view.data.item} />
            )}
          </>
        )}
      </main>
      <footer className="pub-foot dim small">
        {view.data && 'Anyone with this link can view it. '}<a href="/">xstate</a> · business email with agents
      </footer>
    </div>
  )
}

function meta(item: PublicItem, count: number): string {
  if (item.kind === 'folder') return `Folder · ${count} ${count === 1 ? 'item' : 'items'} · View only`
  return `${formatSize(item.size)} · Updated ${formatTime(item.updatedAt)} · View only`
}

function FolderList({ token, items, onOpen }: { token: string; items: PublicItem[]; onOpen: (item: PublicItem) => void }) {
  if (!items.length) {
    return (
      <div className="empty">
        <Icon name="folder" size={24} />
        <strong>This folder is empty</strong>
      </div>
    )
  }
  return (
    <div className="s-table pub-table" role="table" aria-label="Folder contents">
      <div className="pub-row s-row-head" role="row">
        <span role="columnheader">Name</span>
        <span role="columnheader" className="num">Size</span>
        <span role="columnheader" className="num">Modified</span>
        <span />
      </div>
      {items.map((item) => (
        <div key={item.id} role="row" tabIndex={0} className="pub-row" onClick={() => onOpen(item)} onKeyDown={(e) => e.key === 'Enter' && onOpen(item)}>
          <span className="s-name" role="cell">
            <FileIcon name={item.name} contentType={item.contentType} kind={item.kind} />
            <span className="ellipsis">{item.name}</span>
          </span>
          <span className="muted num" role="cell">{item.kind === 'file' ? formatSize(item.size) : '—'}</span>
          <span className="muted num" role="cell" title={new Date(item.updatedAt).toLocaleString()}>{formatTime(item.updatedAt)}</span>
          <span className="s-actions" role="cell">
            {item.kind === 'file' && (
              <a className="ghost" href={publicApi.downloadUrl(token, item.id)} download={item.name} aria-label={`Download ${item.name}`}
                title="Download" onClick={(e) => e.stopPropagation()}>
                <Icon name="download" size={15} />
              </a>
            )}
          </span>
        </div>
      ))}
    </div>
  )
}

function FilePreview({ token, itemId, item }: { token: string; itemId?: string; item: PublicItem }) {
  const kind = fileKind(item.name, item.contentType)
  const preview = PREVIEWABLE.has(kind) && item.size <= MAX_PREVIEW_BYTES
  const blob = useQuery({
    queryKey: ['public', token, itemId ?? '', 'content'],
    queryFn: () => publicApi.content(token, itemId),
    enabled: preview,
    staleTime: Infinity,
  })
  if (!preview) {
    return (
      <div className="empty">
        <Icon name="file" size={28} />
        <strong>{item.name}</strong>
        <span>No preview for this file. {formatSize(item.size)} · Download to open it.</span>
        <a className="btn" style={{ marginTop: 8 }} href={publicApi.downloadUrl(token, itemId)} download={item.name}>
          <Icon name="download" size={14} />Download
        </a>
      </div>
    )
  }
  return (
    <div className="pub-file file-body">
      {blob.isPending ? (
        <div className="loading"><span className="spinner" /></div>
      ) : blob.isError ? (
        <div className="empty"><Icon name="circle-alert" size={24} /><strong>Couldn't load the preview</strong><span>{errorMessage(blob.error)}</span></div>
      ) : (
        <Suspense fallback={<div className="loading"><span className="spinner" /></div>}>
          <FileBody kind={kind} props={{ blob: blob.data, name: item.name, editable: false, onChange: noop, register: noop }} />
        </Suspense>
      )}
    </div>
  )
}

function Gone({ message }: { message: string | null }) {
  return (
    <div className="empty">
      <Icon name="link" size={24} />
      <strong>{message ? "Couldn't open this link" : 'This link doesn’t work'}</strong>
      <span>{message ?? 'It may have been turned off, or the file moved to the trash. Ask the person who sent it for a new link.'}</span>
    </div>
  )
}

const queryClient = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false } } })

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <PublicPage />
    </QueryClientProvider>
  </StrictMode>,
)
