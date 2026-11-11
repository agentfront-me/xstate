// Attachments picked for a reply or a new message: uploaded to the mailbox as soon as they're picked.

import { useCallback, useState } from 'react'
import { Icon } from '../components/Icon'
import { errorMessage } from '../lib/core'
import type { Upload } from '../lib/types'
import { formatSize } from './format'
import type { MailSource } from './source'

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

export type PickedFile = {
  id: string
  name: string
  size: number
  status: 'uploading' | 'ready' | 'error'
  error?: string
  attachment?: Upload
}

/** Picked files and their upload state. Uploads belong to `mailboxId`. */
export function useUploads(source: MailSource, initial: PickedFile[] = []) {
  const [files, setFiles] = useState<PickedFile[]>(initial)

  const add = useCallback(
    (mailboxId: string, list: FileList | File[]) => {
      for (const file of list) {
        const id = `f${Date.now()}${Math.random().toString(36).slice(2, 6)}`
        const set = (patch: Partial<PickedFile>) => setFiles((all) => all.map((f) => (f.id === id ? { ...f, ...patch } : f)))
        if (file.size > MAX_ATTACHMENT_BYTES) {
          setFiles((all) => [...all, { id, name: file.name, size: file.size, status: 'error', error: 'Over the 25 MB limit' }])
          continue
        }
        setFiles((all) => [...all, { id, name: file.name, size: file.size, status: 'uploading' }])
        source
          .upload(mailboxId, file)
          .then((attachment) => set({ status: 'ready', attachment }))
          .catch((err: unknown) => set({ status: 'error', error: errorMessage(err) }))
      }
    },
    [source],
  )

  const remove = (id: string) => setFiles((all) => all.filter((f) => f.id !== id))
  const clear = () => setFiles([])
  return { files, add, remove, clear }
}

/** The uploaded attachments, or why the message can't be sent yet. */
export function readyAttachments(files: PickedFile[]): { attachments: Upload[]; error?: undefined } | { error: string } {
  if (files.some((f) => f.status === 'uploading')) return { error: 'Wait for attachments to finish uploading.' }
  const failed = files.find((f) => f.status === 'error')
  if (failed) return { error: `${failed.name}: ${failed.error ?? 'Upload failed'}. Remove it to send.` }
  return { attachments: files.flatMap((f) => (f.attachment ? [f.attachment] : [])) }
}

export function FileChips({ files, onRemove }: { files: PickedFile[]; onRemove: (id: string) => void }) {
  if (!files.length) return null
  return (
    <div className="attachments files">
      {files.map((f) => (
        <span
          key={f.id}
          className={`attachment${f.status === 'error' ? ' is-error' : warned(f) ? ' is-warn' : ''}`}
          title={f.error ?? (warned(f) ? f.attachment?.safety?.message : f.name)}
        >
          {f.status === 'uploading' ? (
            <span className="spinner" />
          ) : (
            <Icon name={f.status === 'error' ? 'circle-alert' : warned(f) ? 'shield-alert' : 'paperclip'} size={14} />
          )}
          <span className="ellipsis">{f.name}</span>
          <span className="muted small">{f.status === 'error' ? (f.error ?? 'Upload failed') : formatSize(f.size)}</span>
          <button type="button" className="x-btn" onClick={() => onRemove(f.id)} aria-label={`Remove ${f.name}`}>
            <Icon name="x" size={12} />
          </button>
        </span>
      ))}
    </div>
  )
}

/** Uploaded, with a warning from the file-type rules (macros, an archive that couldn't be checked). */
const warned = (f: PickedFile) => f.attachment?.safety?.level === 'warn'
