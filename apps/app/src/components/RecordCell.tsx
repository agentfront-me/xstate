// One DNS record field (a Name or a Value), shared by Settings → Domains, onboarding and the Google migration.
//
// Shows the first ~20 characters (CSS, monospace). Click copies the full text. Hovering or focusing it opens a
// popover with the full text and a Copy button. The popover is portalled with fixed positioning because the record
// tables scroll or clip their overflow and would cut it off.

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { copyText } from '../lib/core'
import { Icon } from './Icon'
import '../styles/record-cell.css'

const POP_WIDTH = 440

export function RecordCell({
  label,
  text,
  className,
  onCopied,
}: {
  /** What the field is, e.g. "TXT value". Shown in the popover and read by screen readers. */
  label: string
  text: string
  className?: string
  /** Called after each copy attempt, e.g. to show a toast. */
  onCopied?: (ok: boolean) => void
}) {
  const ref = useRef<HTMLButtonElement>(null)
  const hideTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const copiedTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const [at, setAt] = useState<{ top: number; left: number } | null>(null)
  const [copied, setCopied] = useState(false)

  const show = () => {
    clearTimeout(hideTimer.current)
    const r = ref.current?.getBoundingClientRect()
    if (r) setAt({ top: r.bottom + 6, left: Math.max(8, Math.min(r.left, window.innerWidth - POP_WIDTH - 8)) })
  }
  const hide = () => {
    clearTimeout(hideTimer.current)
    hideTimer.current = setTimeout(() => setAt(null), 120)
  }
  const copy = async () => {
    const ok = await copyText(text)
    onCopied?.(ok)
    if (!ok) return
    setCopied(true)
    clearTimeout(copiedTimer.current)
    copiedTimer.current = setTimeout(() => setCopied(false), 1500)
  }

  useEffect(() => {
    if (!at) return
    const close = () => setAt(null)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [at])
  useEffect(
    () => () => {
      clearTimeout(hideTimer.current)
      clearTimeout(copiedTimer.current)
    },
    [],
  )

  return (
    <>
      <button
        ref={ref}
        type="button"
        className={`record-cell${className ? ` ${className}` : ''}`}
        aria-label={`Copy ${label}: ${text}`}
        onClick={() => void copy()}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
      >
        {text}
      </button>
      {at &&
        createPortal(
          <div className="record-pop" role="tooltip" style={{ ...at, maxWidth: POP_WIDTH }} onMouseEnter={show} onMouseLeave={hide}>
            <span className="record-pop-label">{label}</span>
            <code>{text}</code>
            <button type="button" className="record-pop-copy" onClick={() => void copy()}>
              <Icon name={copied ? 'check' : 'copy'} size={13} />
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>,
          document.body,
        )}
    </>
  )
}
