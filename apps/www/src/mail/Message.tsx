// One message of a conversation: collapsed to a line, or open with its body, quoted history and attachments.

import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../components/Icon'
import { toast } from '../components/Toast'
import { errorMessage, initials } from '../lib/core'
import { useIsDark } from '../lib/theme'
import type { Attachment, Message } from '../lib/types'
import { avatarStyle, formatSize, formatTime } from './format'
import { isPlainHtml, markQuote, splitQuote } from './quotes'
import type { MailSource } from './source'

type Props = {
  message: Message
  source: MailSource
  open: boolean
  /** The newest message can't be collapsed. */
  last: boolean
  showImages: boolean
  onToggle: () => void
  onShowImages: () => void
}

export function MessageView({ message: m, source, open, last, showImages, onToggle, onShowImages }: Props) {
  const from = m.from[0] ?? { name: null, email: '' }
  const files = m.attachments.filter((a) => !a.inline)
  const to = [...m.to, ...m.cc].map((a) => a.name || a.email).join(', ')
  const head = (
    <>
      <span className="avatar lg" style={avatarStyle(from.email)}>
        {initials(from.name || from.email)}
      </span>
      <div className="who">
        <div className="ellipsis">
          <span className="from">{from.name || from.email}</span>
          {open && from.name && <span className="email"> {from.email}</span>}
        </div>
        <div className="to ellipsis">{open ? `to ${to}` : m.preview}</div>
      </div>
      <span className="time">
        {files.length > 0 && <Icon name="paperclip" size={12} />}
        {formatTime(m.receivedAt)}
      </span>
    </>
  )

  if (!open) {
    return (
      <div className="message is-collapsed">
        <button className="sender" onClick={onToggle} title={from.email}>
          {head}
        </button>
      </div>
    )
  }

  const remote = !!m.html && /\bsrc\s*=\s*["']?https?:/i.test(m.html)
  return (
    <div className="message">
      {last ? (
        <div className="sender" title={from.email}>
          {head}
        </div>
      ) : (
        <button className="sender" onClick={onToggle} title={from.email}>
          {head}
        </button>
      )}
      {m.html ? (
        <>
          {remote && !showImages && (
            <div className="images-note">
              <Icon name="info" size={14} />
              <span>Remote images are hidden to protect your privacy.</span>
              <button onClick={onShowImages}>Show images</button>
            </div>
          )}
          <HtmlBody message={m} source={source} showImages={showImages} />
        </>
      ) : (
        <TextBody text={m.text} />
      )}
      {files.length > 0 && (
        <div className="attachments">
          {files.map((a) => (
            <DownloadButton key={a.blobId} message={m} attachment={a} source={source} />
          ))}
        </div>
      )}
    </div>
  )
}

const Paragraphs = ({ text }: { text: string }) => (
  <>
    {text.split(/\n{2,}/).map((p, i) => (
      <p key={i}>{p}</p>
    ))}
  </>
)

function QuoteToggle({ open, onClick, hidden = false }: { open: boolean; onClick: () => void; hidden?: boolean }) {
  return (
    <button className="quote-toggle" onClick={onClick} aria-expanded={open} title={`${open ? 'Hide' : 'Show'} quoted text`} hidden={hidden}>
      •••
    </button>
  )
}

function TextBody({ text }: { text: string }) {
  const { body, quote } = useMemo(() => splitQuote(text), [text])
  const [quoteOpen, setQuoteOpen] = useState(false)
  return (
    <>
      <div className="message-text">
        <Paragraphs text={body} />
      </div>
      {quote && <QuoteToggle open={quoteOpen} onClick={() => setQuoteOpen((o) => !o)} />}
      {quote && quoteOpen && (
        <div className="message-text quoted">
          <Paragraphs text={quote.replace(/^\s*> ?/gm, '')} />
        </div>
      )}
    </>
  )
}

const themeColor = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim()

/** The HTML document for a message's sandboxed frame. No scripts run; remote images load only when allowed. */
function frameDocument(html: string, plain: boolean, showImages: boolean): string {
  const images = showImages ? 'https: http: data: blob:' : 'data: blob:'
  const base = plain
    ? `:root{color-scheme:${themeColor('color-scheme') || 'light'}}
       html,body{background:transparent;color:${themeColor('--text-hi')}}body{padding:0}
       body *{color:inherit!important;background-color:transparent!important;font-family:inherit!important}
       a{color:${themeColor('--text-hi')}!important;text-decoration:underline}
       blockquote{margin:6px 0;padding-left:12px;border-left:2px solid ${themeColor('--border-strong')};opacity:.8}`
    : `html,body{background:#fff;color:#18181b}body{padding:16px}a{color:#2563eb}`
  return `<!doctype html><html><head><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${images}; style-src 'unsafe-inline'; font-src data:">
    <base target="_blank">
    <style>html,body{margin:0;font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;overflow-wrap:anywhere;-webkit-font-smoothing:antialiased}
    ${base}img{max-width:100%;height:auto}table{max-width:100%}
    body.xq-hide [data-xq]{display:none!important}
    ${showImages ? '' : 'img[src^="http:"],img[src^="https:"]{display:none}'}</style></head>
    <body>${html}</body></html>`
}

/** Replaces cid: references with blob URLs of the message's inline attachments. */
async function withInlineImages(m: Message, source: MailSource): Promise<{ html: string; urls: string[] }> {
  let html = m.html ?? ''
  const urls: string[] = []
  for (const a of m.attachments.filter((x) => x.cid && html.includes(`cid:${x.cid}`))) {
    try {
      const url = URL.createObjectURL(await source.attachment(m, a))
      urls.push(url)
      html = html.split(`cid:${a.cid}`).join(url)
    } catch {
      // Leave that image broken; the rest of the message still shows.
    }
  }
  return { html, urls }
}

function HtmlBody({ message, source, showImages }: { message: Message; source: MailSource; showImages: boolean }) {
  const dark = useIsDark()
  const frame = useRef<HTMLIFrameElement>(null)
  const [html, setHtml] = useState<string | null>(null)
  const [hasQuote, setHasQuote] = useState(false)
  const [quoteOpen, setQuoteOpen] = useState(false)
  const quoteOpenRef = useRef(quoteOpen)
  quoteOpenRef.current = quoteOpen
  const plain = isPlainHtml(message.html ?? '')

  useEffect(() => {
    let alive = true
    let urls: string[] = []
    void withInlineImages(message, source).then((r) => {
      urls = r.urls
      if (alive) setHtml(r.html)
      else urls.forEach((u) => URL.revokeObjectURL(u))
    })
    return () => {
      alive = false
      urls.forEach((u) => URL.revokeObjectURL(u))
    }
  }, [message, source])

  // Simple mail is drawn in the theme's colours, so the document is rebuilt when the theme changes.
  const srcDoc = useMemo(() => (html === null ? undefined : frameDocument(html, plain, showImages)), [html, plain, showImages, dark])

  const resize = () => {
    const el = frame.current
    const doc = el?.contentDocument
    if (!el || !doc?.body) return
    el.style.height = '0px'
    el.style.height = `${doc.body.scrollHeight}px`
  }

  const onLoad = () => {
    const doc = frame.current?.contentDocument
    if (!doc?.body) return
    const found = markQuote(doc)
    setHasQuote(found)
    if (found) doc.body.classList.toggle('xq-hide', !quoteOpenRef.current)
    resize()
  }

  useEffect(() => {
    const doc = frame.current?.contentDocument
    if (!doc?.body || !hasQuote) return
    doc.body.classList.toggle('xq-hide', !quoteOpen)
    resize()
  }, [quoteOpen, hasQuote])

  return (
    <>
      <iframe
        ref={frame}
        className={`mail-html${plain ? ' is-plain' : ''}`}
        sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        title="Message"
        srcDoc={srcDoc}
        onLoad={onLoad}
      />
      <QuoteToggle open={quoteOpen} onClick={() => setQuoteOpen((o) => !o)} hidden={!hasQuote} />
    </>
  )
}

function DownloadButton({ message, attachment: a, source }: { message: Message; attachment: Attachment; source: MailSource }) {
  const [busy, setBusy] = useState(false)
  const download = async () => {
    setBusy(true)
    try {
      const url = URL.createObjectURL(await source.attachment(message, a))
      const link = Object.assign(document.createElement('a'), { href: url, download: a.name })
      document.body.append(link)
      link.click()
      link.remove()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    } catch (err) {
      toast(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <button className="attachment" onClick={() => void download()} title={`Download ${a.name}`} aria-busy={busy || undefined}>
      <Icon name="paperclip" size={14} />
      <span className="ellipsis">{a.name}</span>
      <span className="muted small">{formatSize(a.size)}</span>
      <Icon name="download" size={14} />
    </button>
  )
}
