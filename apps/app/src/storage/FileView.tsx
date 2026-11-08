// One open file: its viewer or editor, with Save, Share, Versions and Download. Mail attachments open read-only,
// with "Save to My Files" to get an editable copy.
//
// Saving sends the version the editor started from; if someone saved in between, the API answers 409 and the
// page offers to save a copy instead, so nobody's work is overwritten.

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from '../components/Icon'
import { toast } from '../components/Toast'
import { ApiError, errorMessage, isMac } from '../lib/core'
import { formatSize, formatTime } from '../mail/format'
import { type StorageItem, EDITABLE, canEdit, fileKind, saveBlob, storageApi } from './api'
import { ShareDialog, VersionsDialog } from './dialogs'
import type { StorageSearch } from './StoragePage'
import { storageKeys } from './StoragePage'
import { FileIcon } from './FileIcon'
import { FileBody } from './FileBody'
import type { EditorProps } from './viewers/types'


type Target = { kind: 'item'; id: string } | { kind: 'attachment'; id: string }

type Loaded = {
  name: string
  contentType: string | null
  size: number
  blob: Blob
  item: StorageItem | null
  /** For attachments: the mailbox and date shown under the name. */
  attachment?: { createdAt: string; source: 'received' | 'sent'; address: string }
}

export function FileView({ orgId, target, onClose, go }: { orgId: string; target: Target; onClose: () => void; go: (s: StorageSearch) => void }) {
  const client = useQueryClient()
  const [item, setItem] = useState<StorageItem | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [dialog, setDialog] = useState<'share' | 'versions' | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const read = useRef<(() => Blob | Promise<Blob>) | null>(null)
  /** The version the editor's contents are based on. */
  const baseVersion = useRef(0)

  const loaded = useQuery({
    queryKey: [...storageKeys.all, 'open', target.kind, target.id, reloadKey],
    staleTime: Infinity,
    gcTime: 0,
    queryFn: async (): Promise<Loaded> => {
      if (target.kind === 'item') {
        const { item } = await storageApi.item(target.id)
        const blob = item.kind === 'file' ? await storageApi.content(item.id) : new Blob()
        return { name: item.name, contentType: item.contentType, size: item.size, blob, item }
      }
      const [{ file, mailbox }, blob] = await Promise.all([storageApi.attachment(target.id), storageApi.attachmentContent(target.id)])
      return {
        name: file.name,
        contentType: file.contentType,
        size: file.size,
        blob,
        item: null,
        attachment: { createdAt: file.createdAt, source: file.source, address: mailbox.address },
      }
    },
  })

  useEffect(() => {
    if (loaded.data?.item) {
      setItem(loaded.data.item)
      baseVersion.current = loaded.data.item.version
      setDirty(false)
      setConflict(false)
    }
  }, [loaded.data])

  const data = loaded.data
  const kind = data ? fileKind(data.name, data.contentType) : 'other'
  const editable = !!item && canEdit(item) && EDITABLE.includes(kind)

  const onChange = useCallback(() => setDirty(true), [])
  const register = useCallback((fn: () => Blob | Promise<Blob>) => {
    read.current = fn
  }, [])

  const save = useCallback(async () => {
    if (!item || !read.current || saving) return
    setSaving(true)
    try {
      const blob = await read.current()
      const saved = await storageApi.save(item, baseVersion.current, blob)
      baseVersion.current = saved.version
      setItem(saved)
      setDirty(false)
      void client.invalidateQueries({ queryKey: [...storageKeys.all, 'folder'] })
      void client.invalidateQueries({ queryKey: [...storageKeys.all, 'top'] })
      toast('Saved')
    } catch (err) {
      if (err instanceof ApiError && err.code === 'version_conflict') setConflict(true)
      else toast(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }, [client, item, saving])

  /** After a conflict: keep both by saving these edits as a new file next to the original. */
  const saveCopy = async () => {
    if (!item || !read.current) return
    try {
      const blob = await read.current()
      const dot = item.name.lastIndexOf('.')
      const name = dot > 0 ? `${item.name.slice(0, dot)} (my copy)${item.name.slice(dot)}` : `${item.name} (my copy)`
      const where = item.parentId ? { parentId: item.parentId } : { space: item.space }
      const copy = await storageApi.upload(orgId, new File([blob], name, { type: item.contentType ?? blob.type }), where)
      setDirty(false)
      toast(`Saved as ${copy.name}`)
      go({ open: copy.id })
    } catch (err) {
      toast(errorMessage(err))
    }
  }

  // ⌘S / Ctrl+S saves.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((isMac ? e.metaKey : e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        if (editable && dirty) void save()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [dirty, editable, save])

  // Closing the window or tab with unsaved changes asks first.
  useEffect(() => {
    if (!dirty) return
    const onUnload = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', onUnload)
    return () => window.removeEventListener('beforeunload', onUnload)
  }, [dirty])

  const close = () => {
    if (dirty && !window.confirm('Leave without saving your changes?')) return
    onClose()
  }

  const saveToMyFiles = async () => {
    try {
      const copy = await storageApi.saveAttachment(target.id)
      void client.invalidateQueries({ queryKey: storageKeys.all })
      toast(`Saved ${copy.name} to My Files`)
      go({ view: 'personal', open: copy.id })
    } catch (err) {
      toast(errorMessage(err))
    }
  }

  const props: EditorProps | null = data ? { blob: data.blob, name: data.name, editable, onChange, register } : null

  // Escape closes, unless a dialog on top is open (it closes itself first).
  useEffect(() => {
    if (dialog) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !e.defaultPrevented && close()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  })

  const name = item?.name ?? data?.name ?? ''
  const meta = item
    ? `${dirty ? 'Unsaved changes' : `${formatSize(item.size)} · Version ${item.version} · ${formatTime(item.updatedAt)}${item.updatedBy ? ` by ${item.updatedBy}` : ''}`}${editable ? '' : ' · View only'}`
    : data?.attachment
      ? `${formatSize(data.size)} · ${data.attachment.source === 'sent' ? 'Sent from' : 'Received in'} ${data.attachment.address} · ${formatTime(data.attachment.createdAt)} · Read-only`
      : ''

  return (
    <div className="preview-scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <section className="preview" role="dialog" aria-modal="true" aria-label={name}>
        <div className="preview-head">
          <FileIcon name={name} contentType={data?.contentType ?? null} kind="file" bare />
          <div className="grow preview-title">
            <span className="name ellipsis">{name}</span>
            <span className="meta ellipsis">{meta}</span>
          </div>
          {item && (
            <>
              <button className="btn btn-sm" onClick={() => setDialog('versions')}><Icon name="history" size={14} />Versions</button>
              <button className="btn btn-sm" onClick={() => setDialog('share')}><Icon name="user-plus" size={14} />{item.role === 'manager' ? 'Share' : 'Access'}</button>
            </>
          )}
          {data && (
            <button className="btn btn-sm" onClick={() => saveBlob(data.blob, data.name)} title="Download the version you opened">
              <Icon name="download" size={14} />Download
            </button>
          )}
          {target.kind === 'attachment' && data && (
            <button className="btn btn-sm btn-primary" onClick={() => void saveToMyFiles()}>
              <Icon name="hard-drive" size={14} />Save to My Files
            </button>
          )}
          {editable && (
            <button className="btn btn-sm btn-primary" disabled={!dirty || saving} onClick={() => void save()} title={isMac ? '⌘S' : 'Ctrl+S'}>
              {saving ? <span className="spinner" /> : <Icon name="save" size={14} />}Save
            </button>
          )}
          <button className="ghost preview-close" onClick={close} aria-label="Close"><Icon name="x" size={16} /></button>
        </div>

        {conflict && (
          <div className="conflict">
            <Icon name="circle-alert" size={15} />
            <span>Someone else saved this file while you were editing.</span>
            <button className="btn btn-sm" onClick={() => void saveCopy()}>Save my edits as a copy</button>
            <button className="btn btn-sm btn-quiet" onClick={() => { setDirty(false); setReloadKey((k) => k + 1) }}>Discard mine and reload</button>
          </div>
        )}

        <div className="file-body">
          {loaded.isPending ? (
            <div className="loading"><span className="spinner" /></div>
          ) : loaded.isError ? (
            <div className="empty">
              <Icon name="circle-alert" size={24} />
              <strong>Couldn't open this file</strong>
              <span>{errorMessage(loaded.error)}</span>
            </div>
          ) : props ? (
            <Suspense fallback={<div className="loading"><span className="spinner" /></div>}>
              <FileBody kind={kind} props={props} />
            </Suspense>
          ) : null}
        </div>
      </section>

      {item && dialog === 'share' && <ShareDialog orgId={orgId} item={item} onClose={() => setDialog(null)} />}
      {item && dialog === 'versions' && (
        <VersionsDialog
          item={item}
          onClose={() => setDialog(null)}
          onRestored={(restored) => {
            setItem(restored)
            setReloadKey((k) => k + 1)
          }}
        />
      )}
    </div>
  )
}
