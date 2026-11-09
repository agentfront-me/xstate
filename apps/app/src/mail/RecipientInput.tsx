// A To / Cc / Bcc field that suggests contacts as you type: the address being typed (after the last comma) is looked
// up in your contacts and the organization's shared ones, then Google's "Other contacts". ↑ ↓ to move, Enter or Tab
// to pick, Escape to close. Recipients stay plain addresses separated by commas.

import { useEffect, useRef, useState, type Ref } from 'react'
import { audienceApi } from '../users/api'

type Suggestion = { name: string | null; email: string }

/** The address being typed: everything after the last separator. */
const current = (value: string) => value.slice(Math.max(value.lastIndexOf(','), value.lastIndexOf(';')) + 1).trim()

export function RecipientInput({
  id,
  value,
  onChange,
  orgId,
  placeholder,
  inputRef,
}: {
  id: string
  value: string
  onChange: (value: string) => void
  /** Null in demo mode: no suggestions. */
  orgId: string | null
  placeholder?: string
  inputRef?: Ref<HTMLInputElement>
}) {
  const [items, setItems] = useState<Suggestion[]>([])
  const [active, setActive] = useState(0)
  const [open, setOpen] = useState(false)
  const typed = current(value)
  const seq = useRef(0)

  useEffect(() => {
    if (!orgId || typed.length < 2 || typed.includes('@') && /\.[a-z]{2,}$/i.test(typed)) {
      setItems([])
      return
    }
    const n = ++seq.current
    const timer = setTimeout(() => {
      audienceApi
        .suggest(orgId, typed)
        .then((r) => {
          if (n !== seq.current) return
          // Leave out addresses already in the field.
          const chosen = new Set(value.toLowerCase().split(/[\s,;]+/))
          setItems(r.contacts.filter((c) => !chosen.has(c.email)))
          setActive(0)
        })
        .catch(() => setItems([]))
    }, 150)
    return () => clearTimeout(timer)
  }, [orgId, typed, value])

  const pick = (s: Suggestion) => {
    const cut = Math.max(value.lastIndexOf(','), value.lastIndexOf(';')) + 1
    const before = value.slice(0, cut).trimEnd()
    onChange(`${before ? `${before} ` : ''}${s.email}, `)
    setItems([])
  }

  const shown = open && items.length > 0

  return (
    <span className="rcpt">
      <input
        ref={inputRef}
        id={id}
        placeholder={placeholder}
        autoComplete="off"
        role="combobox"
        aria-expanded={shown}
        aria-controls={`${id}-list`}
        aria-autocomplete="list"
        value={value}
        onChange={(e) => {
          onChange(e.target.value)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => {
          if (!shown) return
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length)
          } else if (e.key === 'Enter' || e.key === 'Tab') {
            e.preventDefault()
            pick(items[active]!)
          } else if (e.key === 'Escape') {
            e.stopPropagation()
            setOpen(false)
          }
        }}
      />
      {shown && (
        <ul className="rcpt-list" id={`${id}-list`} role="listbox">
          {items.map((s, i) => (
            <li
              key={s.email}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault()
                pick(s)
              }}
              onMouseEnter={() => setActive(i)}
            >
              <span className="hi ellipsis">{s.name ?? s.email}</span>
              {s.name && <span className="muted small ellipsis">{s.email}</span>}
            </li>
          ))}
        </ul>
      )}
    </span>
  )
}
