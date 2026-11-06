// Markdown files in a rich editor: Tiptap (ProseMirror) with @tiptap/markdown, which reads and writes Markdown both
// ways. You edit formatted text; the file stays plain .md. "Source" shows the Markdown itself.
// Loaded on demand (React.lazy).

import { Markdown } from '@tiptap/markdown'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { TableKit } from '@tiptap/extension-table'
import { Placeholder } from '@tiptap/extensions'
import { type Editor, EditorContent, useEditor, useEditorState } from '@tiptap/react'
import { BubbleMenu } from '@tiptap/react/menus'
import StarterKit from '@tiptap/starter-kit'
import { useEffect, useRef, useState } from 'react'
import { Icon, type IconName } from '../../components/Icon'
import type { EditorProps } from './types'

export default function MarkdownEditor({ blob, editable, onChange, register }: EditorProps) {
  const [initial, setInitial] = useState<string | null>(null)
  const [source, setSource] = useState<string | null>(null) // non-null while showing the Markdown source
  const sourceRef = useRef<string | null>(null)
  sourceRef.current = source

  useEffect(() => {
    let cancelled = false
    void blob.text().then((text) => !cancelled && setInitial(text))
    return () => {
      cancelled = true
    }
  }, [blob])

  const editor = useEditor(
    {
      editable,
      extensions: [
        StarterKit.configure({ link: { openOnClick: false, autolink: true } }),
        Markdown,
        TaskList,
        TaskItem.configure({ nested: true }),
        TableKit.configure({ table: { resizable: false } }),
        Placeholder.configure({ placeholder: editable ? 'Start writing…' : '' }),
      ],
      content: initial ?? '',
      contentType: 'markdown',
      onUpdate: () => onChange(),
    },
    [initial === null, editable],
  )

  useEffect(() => {
    if (!editor) return
    register(() => {
      const md = sourceRef.current ?? tidy(editor.getMarkdown())
      return new Blob([md.endsWith('\n') ? md : `${md}\n`], { type: 'text/markdown' })
    })
  }, [editor, register])

  if (initial === null || !editor) return <div className="loading"><span className="spinner" /></div>

  const showSource = (on: boolean) => {
    if (on && source === null) setSource(tidy(editor.getMarkdown()))
    if (!on && source !== null) {
      editor.commands.setContent(source, { contentType: 'markdown', emitUpdate: false })
      setSource(null)
    }
  }

  return (
    <div className="md-editor">
      <div className="viewer-bar md-bar">
        <div className="tabs" role="tablist" aria-label="View">
          <button role="tab" aria-selected={source === null} onClick={() => showSource(false)}>Preview</button>
          <button role="tab" aria-selected={source !== null} onClick={() => showSource(true)}>Source</button>
        </div>
        {editable && source === null && (
          <>
            <span className="tool-sep" />
            <Toolbar editor={editor} />
          </>
        )}
        <span className="spacer" />
        {!editable && <span className="muted small">View only</span>}
      </div>
      <div className="md-scroll">
        {source !== null ? (
          <textarea
            className="md-source"
            value={source}
            readOnly={!editable}
            spellCheck={false}
            onChange={(e) => {
              setSource(e.target.value)
              onChange()
            }}
          />
        ) : (
          <>
            {editable && <SelectionMenu editor={editor} />}
            <EditorContent editor={editor} className="md-doc" />
          </>
        )}
      </div>
    </div>
  )
}

/**
 * The serializer leaves extra blank lines around some blocks (tables). Collapses runs of blank lines to one and
 * trims the end, outside fenced code blocks, whose contents are kept exactly.
 */
function tidy(md: string): string {
  let inFence = false
  const out: string[] = []
  for (const line of md.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence
    if (!inFence && line.trim() === '' && out.at(-1)?.trim() === '') continue
    out.push(line)
  }
  return `${out.join('\n').trimEnd()}\n`
}

type Tool = { icon: IconName; label: string; active?: (e: Editor) => boolean; run: (e: Editor) => void }

const BLOCK_TOOLS: (Tool | 'sep')[] = [
  { icon: 'heading-1', label: 'Heading 1', active: (e) => e.isActive('heading', { level: 1 }), run: (e) => e.chain().focus().toggleHeading({ level: 1 }).run() },
  { icon: 'heading-2', label: 'Heading 2', active: (e) => e.isActive('heading', { level: 2 }), run: (e) => e.chain().focus().toggleHeading({ level: 2 }).run() },
  { icon: 'heading-3', label: 'Heading 3', active: (e) => e.isActive('heading', { level: 3 }), run: (e) => e.chain().focus().toggleHeading({ level: 3 }).run() },
  'sep',
  { icon: 'bold', label: 'Bold', active: (e) => e.isActive('bold'), run: (e) => e.chain().focus().toggleBold().run() },
  { icon: 'italic', label: 'Italic', active: (e) => e.isActive('italic'), run: (e) => e.chain().focus().toggleItalic().run() },
  { icon: 'strikethrough', label: 'Strikethrough', active: (e) => e.isActive('strike'), run: (e) => e.chain().focus().toggleStrike().run() },
  { icon: 'code', label: 'Inline code', active: (e) => e.isActive('code'), run: (e) => e.chain().focus().toggleCode().run() },
  'sep',
  { icon: 'list', label: 'Bulleted list', active: (e) => e.isActive('bulletList'), run: (e) => e.chain().focus().toggleBulletList().run() },
  { icon: 'list-ordered', label: 'Numbered list', active: (e) => e.isActive('orderedList'), run: (e) => e.chain().focus().toggleOrderedList().run() },
  { icon: 'list-checks', label: 'Checklist', active: (e) => e.isActive('taskList'), run: (e) => e.chain().focus().toggleTaskList().run() },
  { icon: 'quote', label: 'Quote', active: (e) => e.isActive('blockquote'), run: (e) => e.chain().focus().toggleBlockquote().run() },
  { icon: 'square-code', label: 'Code block', active: (e) => e.isActive('codeBlock'), run: (e) => e.chain().focus().toggleCodeBlock().run() },
  { icon: 'table', label: 'Table', active: (e) => e.isActive('table'), run: (e) => e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
  { icon: 'minus', label: 'Divider', run: (e) => e.chain().focus().setHorizontalRule().run() },
  'sep',
  { icon: 'undo-2', label: 'Undo', run: (e) => e.chain().focus().undo().run() },
  { icon: 'redo-2', label: 'Redo', run: (e) => e.chain().focus().redo().run() },
]

function Toolbar({ editor }: { editor: Editor }) {
  // Re-render on selection and content changes, so active states stay right.
  const active = useEditorState({
    editor,
    selector: ({ editor: e }) => BLOCK_TOOLS.map((t) => (t !== 'sep' && t.active ? t.active(e) : false)),
  })
  return (
    <div className="md-tools" role="toolbar" aria-label="Formatting">
      {BLOCK_TOOLS.map((t, i) =>
        t === 'sep' ? (
          <span key={i} className="tool-sep" />
        ) : (
          <button key={t.label} className="ghost" title={t.label} aria-label={t.label} aria-pressed={active[i] || undefined} onClick={() => t.run(editor)}>
            <Icon name={t.icon} size={15} />
          </button>
        ),
      )}
      {editor.isActive('table') && (
        <>
          <span className="tool-sep" />
          <button className="btn-tool" onClick={() => editor.chain().focus().addRowAfter().run()}>+ Row</button>
          <button className="btn-tool" onClick={() => editor.chain().focus().addColumnAfter().run()}>+ Column</button>
          <button className="btn-tool" onClick={() => editor.chain().focus().deleteTable().run()}>Delete table</button>
        </>
      )}
    </div>
  )
}

/** Shown over selected text: quick marks and a link. */
function SelectionMenu({ editor }: { editor: Editor }) {
  const [linking, setLinking] = useState<string | null>(null)
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({ bold: e.isActive('bold'), italic: e.isActive('italic'), strike: e.isActive('strike'), code: e.isActive('code'), link: e.isActive('link') }),
  })
  const applyLink = () => {
    const href = (linking ?? '').trim()
    if (!href) editor.chain().focus().extendMarkRange('link').unsetLink().run()
    else editor.chain().focus().extendMarkRange('link').setLink({ href: /^[a-z]+:/i.test(href) ? href : `https://${href}` }).run()
    setLinking(null)
  }
  return (
    <BubbleMenu editor={editor} className="bubble" shouldShow={({ editor: e, state: s }) => !s.selection.empty && !e.isActive('codeBlock')}>
      {linking !== null ? (
        <form
          className="bubble-link"
          onSubmit={(e) => {
            e.preventDefault()
            applyLink()
          }}
        >
          <input autoFocus value={linking} placeholder="Paste a link" onChange={(e) => setLinking(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setLinking(null)} />
          <button className="ghost" type="submit" aria-label="Apply link"><Icon name="check" size={14} /></button>
        </form>
      ) : (
        <>
          <button className="ghost" aria-pressed={state.bold || undefined} aria-label="Bold" onClick={() => editor.chain().focus().toggleBold().run()}><Icon name="bold" size={14} /></button>
          <button className="ghost" aria-pressed={state.italic || undefined} aria-label="Italic" onClick={() => editor.chain().focus().toggleItalic().run()}><Icon name="italic" size={14} /></button>
          <button className="ghost" aria-pressed={state.strike || undefined} aria-label="Strikethrough" onClick={() => editor.chain().focus().toggleStrike().run()}><Icon name="strikethrough" size={14} /></button>
          <button className="ghost" aria-pressed={state.code || undefined} aria-label="Inline code" onClick={() => editor.chain().focus().toggleCode().run()}><Icon name="code" size={14} /></button>
          <button className="ghost" aria-pressed={state.link || undefined} aria-label="Link" onClick={() => setLinking((editor.getAttributes('link').href as string | undefined) ?? '')}><Icon name="link" size={14} /></button>
        </>
      )}
    </BubbleMenu>
  )
}
