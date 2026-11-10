// One DNS record field (a Name or a Value), shared by Settings → Domains, onboarding and the Google migration.
//
// The text takes the room its column gives it and ends in an ellipsis when it doesn't fit; hovering shows the full
// text. A copy button sits right after it and always copies the full text. Where a layout already has its own copy
// button (the onboarding and migration cards), pass `copy={false}` to get just the truncated text.

import { useEffect, useRef, useState } from 'react'
import { copyText } from '../lib/core'
import { Icon } from './Icon'
import '../styles/record-cell.css'

export function RecordCell({
  label,
  text,
  className,
  copy = true,
  onCopied,
}: {
  /** What the field is, e.g. "MX name". Used for the copy button's label and passed to `onCopied`. */
  label: string
  text: string
  className?: string
  copy?: boolean
  /** Called after each copy attempt, e.g. to show a toast ("Copied MX name"). */
  onCopied?: (ok: boolean, label: string) => void
}) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])

  const textEl = (
    <span className={`record-cell-text${!copy && className ? ` ${className}` : ''}`} title={text}>
      {text}
    </span>
  )
  if (!copy) return textEl

  const onCopy = async () => {
    const ok = await copyText(text)
    onCopied?.(ok, label)
    if (!ok) return
    setCopied(true)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(false), 1500)
  }

  return (
    <span className={`record-cell${className ? ` ${className}` : ''}`}>
      {textEl}
      <button type="button" className="record-cell-copy" aria-label={copied ? 'Copied' : `Copy ${label}`} title={copied ? 'Copied' : `Copy ${label}`} onClick={() => void onCopy()}>
        <Icon name={copied ? 'check' : 'copy'} size={13} />
      </button>
    </span>
  )
}
