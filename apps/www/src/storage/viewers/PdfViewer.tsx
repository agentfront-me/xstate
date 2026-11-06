// PDFs with pdf.js: pages, zoom, search-free text selection, and pdf.js's own annotation editor (highlight, text
// notes, drawing, images). Saving writes the annotations into the PDF (saveDocument) as a new version.
// Changing the PDF's existing text isn't something any web library does well, so that's not offered.
// Loaded on demand (React.lazy); pdf.js runs its parser in a worker.

import 'pdfjs-dist/web/pdf_viewer.css'
import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { useEffect, useRef, useState } from 'react'
import { Icon, type IconName } from '../../components/Icon'
import type { EditorProps } from './types'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
// pdf_viewer.mjs reads the core library from this global.
;(globalThis as unknown as { pdfjsLib: typeof pdfjs }).pdfjsLib = pdfjs
const viewerModule = import('pdfjs-dist/web/pdf_viewer.mjs')

const { AnnotationEditorType } = pdfjs

const MODES: { mode: number; icon: IconName; label: string }[] = [
  { mode: AnnotationEditorType.NONE, icon: 'mouse-pointer', label: 'Select' },
  { mode: AnnotationEditorType.HIGHLIGHT, icon: 'highlighter', label: 'Highlight' },
  { mode: AnnotationEditorType.FREETEXT, icon: 'type', label: 'Add text' },
  { mode: AnnotationEditorType.INK, icon: 'pen-line', label: 'Draw' },
  { mode: AnnotationEditorType.STAMP, icon: 'image', label: 'Add image' },
]

type Viewer = InstanceType<Awaited<typeof viewerModule>['PDFViewer']>

export default function PdfViewer({ blob, editable, onChange, register }: EditorProps) {
  const container = useRef<HTMLDivElement>(null)
  const viewerEl = useRef<HTMLDivElement>(null)
  const viewer = useRef<Viewer | null>(null)
  const doc = useRef<pdfjs.PDFDocumentProxy | null>(null)
  const [mode, setMode] = useState<number>(AnnotationEditorType.NONE)
  const [pages, setPages] = useState(0)
  const [scale, setScale] = useState(1)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    let task: pdfjs.PDFDocumentLoadingTask | null = null
    void (async () => {
      try {
        const { EventBus, PDFLinkService, PDFViewer: Viewer } = await viewerModule
        const data = new Uint8Array(await blob.arrayBuffer())
        if (cancelled || !container.current || !viewerEl.current) return
        const eventBus = new EventBus()
        const linkService = new PDFLinkService({ eventBus, externalLinkTarget: 2 /* LinkTarget.BLANK */ })
        const v = new Viewer({
          container: container.current,
          viewer: viewerEl.current,
          eventBus,
          linkService,
          // Annotation tools only for people who can save the result.
          annotationEditorMode: editable ? AnnotationEditorType.NONE : AnnotationEditorType.DISABLE,
        })
        linkService.setViewer(v)
        eventBus.on('pagesinit', () => {
          v.currentScaleValue = 'page-width'
          setScale(v.currentScale)
        })
        eventBus.on('scalechanging', (e: { scale: number }) => setScale(e.scale))
        // Any drawing, highlight or note that can be undone is an unsaved change.
        eventBus.on('editingstateschanged', (e: { details: { hasSomethingToUndo?: boolean } }) => {
          if (e.details.hasSomethingToUndo) onChange()
        })
        viewer.current = v
        task = pdfjs.getDocument({ data })
        const pdf = await task.promise
        if (cancelled) return
        doc.current = pdf
        ;(pdf.annotationStorage as unknown as { onSetModified: () => void }).onSetModified = () => onChange()
        v.setDocument(pdf)
        linkService.setDocument(pdf)
        setPages(pdf.numPages)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'This PDF could not be opened.')
      }
    })()
    return () => {
      cancelled = true
      void task?.destroy()
      doc.current = null
      viewer.current = null
    }
    // onChange is stable for the page's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blob, editable])

  useEffect(() => {
    register(async () => {
      const pdf = doc.current
      if (!pdf) return blob
      return new Blob([await pdf.saveDocument()], { type: 'application/pdf' })
    })
  }, [blob, register])

  const pickMode = (next: number) => {
    const v = viewer.current
    if (!v) return
    v.annotationEditorMode = { mode: next }
    setMode(next)
  }

  const zoom = (factor: number) => {
    const v = viewer.current
    if (v) v.currentScale = Math.min(4, Math.max(0.25, v.currentScale * factor))
  }

  if (error) {
    return (
      <div className="empty">
        <Icon name="circle-alert" size={24} />
        <strong>Couldn't open this PDF</strong>
        <span>{error}</span>
      </div>
    )
  }

  return (
    <div className="pdf">
      <div className="viewer-bar">
        {editable ? (
          <div className="md-tools" role="toolbar" aria-label="Annotate">
            {MODES.map((m) => (
              <button key={m.label} className="ghost" title={m.label} aria-label={m.label} aria-pressed={mode === m.mode || undefined} onClick={() => pickMode(m.mode)}>
                <Icon name={m.icon} size={15} />
              </button>
            ))}
          </div>
        ) : (
          <span className="muted small">View only</span>
        )}
        <span className="spacer" />
        <span className="muted small">{pages ? `${pages} page${pages === 1 ? '' : 's'}` : ''}</span>
        <button className="ghost" aria-label="Zoom out" onClick={() => zoom(1 / 1.2)}><Icon name="zoom-out" size={15} /></button>
        <span className="muted small zoom">{Math.round(scale * 100)}%</span>
        <button className="ghost" aria-label="Zoom in" onClick={() => zoom(1.2)}><Icon name="zoom-in" size={15} /></button>
      </div>
      <div className="pdf-stage">
        <div ref={container} className="pdf-container">
          <div ref={viewerEl} className="pdfViewer" />
        </div>
      </div>
    </div>
  )
}
