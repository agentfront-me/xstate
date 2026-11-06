// The preview or editor for one file, picked by its kind. Shared by the Storage window and the public link page.
// The editors load on demand.

import { lazy, useEffect, useState } from 'react'
import { Icon } from '../components/Icon'
import { formatSize } from '../mail/format'
import { type FileKind, saveBlob } from './api'
import type { EditorProps } from './viewers/types'

const CsvEditor = lazy(() => import('./viewers/CsvEditor'))
const MarkdownEditor = lazy(() => import('./viewers/MarkdownEditor'))
const PdfViewer = lazy(() => import('./viewers/PdfViewer'))

export function FileBody({ kind, props }: { kind: FileKind; props: EditorProps }) {
  if (kind === 'csv') return <CsvEditor {...props} />
  if (kind === 'markdown') return <MarkdownEditor {...props} />
  if (kind === 'pdf') return <PdfViewer {...props} />
  if (kind === 'image') return <ImagePreview blob={props.blob} name={props.name} />
  if (kind === 'text') return <TextPreview blob={props.blob} />
  return (
    <div className="empty">
      <Icon name="file" size={28} />
      <strong>{props.name}</strong>
      <span>No preview for this file type. {formatSize(props.blob.size)} · Download to open it locally.</span>
      <button className="btn" style={{ marginTop: 8 }} onClick={() => saveBlob(props.blob, props.name)}>
        <Icon name="download" size={14} />Download
      </button>
    </div>
  )
}

function ImagePreview({ blob, name }: { blob: Blob; name: string }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    const u = URL.createObjectURL(blob)
    setUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [blob])
  return <div className="image-stage">{url && <img src={url} alt={name} />}</div>
}

function TextPreview({ blob }: { blob: Blob }) {
  const [text, setText] = useState('')
  useEffect(() => {
    // Large text files show their start; the rest is a download away.
    void blob.slice(0, 2 * 1024 * 1024).text().then(setText)
  }, [blob])
  return <pre className="text-stage">{text}</pre>
}
