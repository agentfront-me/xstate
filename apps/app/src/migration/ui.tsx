// Pieces shared by the migration steps: the step bar, panels, progress bars, state chips, menus and the
// confirmation dialog, plus number and size formatting.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Icon, type IconName } from '../components/Icon'
import { useCopied } from '../onboarding/ui'
import { STEPS, stepIndex, type Count, type Stage, type UserState } from './types'

// ---------------------------------------------------------------------------------------------------------------
// Formatting

const nf = new Intl.NumberFormat('en-US')
export const num = (n: number) => nf.format(n)

export function bytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v >= 100 || i < 3 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, '')} ${units[i]}`
}

/** "about 1 day 6 hours", "about 25 minutes". */
export function duration(seconds: number): string {
  const m = Math.round(seconds / 60)
  if (m < 60) return `about ${Math.max(1, m)} minute${m === 1 ? '' : 's'}`
  const h = Math.round(seconds / 3600)
  if (h < 24) return `about ${h} hour${h === 1 ? '' : 's'}`
  const d = Math.floor(h / 24)
  const rest = h % 24
  return `about ${d} day${d === 1 ? '' : 's'}${rest ? ` ${rest} hour${rest === 1 ? '' : 's'}` : ''}`
}

export const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
export const day = (iso: string) => new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' })

export const plural = (n: number, one: string, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`

// ---------------------------------------------------------------------------------------------------------------
// Layout

export function StepBar({ stage }: { stage: Stage }) {
  const current = stepIndex(stage)
  return (
    <ol className="steps" aria-label="Migration steps">
      {STEPS.map((s, i) => {
        const done = i < current
        return (
          <li key={s.stage} className={done ? 'is-done' : i === current ? 'is-current' : undefined} aria-current={i === current ? 'step' : undefined}>
            <span className="dot">{done ? <Icon name="check" size={10} /> : i + 1}</span>
            <span className="label">{s.label}</span>
          </li>
        )
      })}
    </ol>
  )
}

export function Title({ title, sub, aside, spinner }: { title: string; sub: ReactNode; aside?: ReactNode; spinner?: boolean }) {
  return (
    <div className="m-head">
      <div className="text">
        <h1>
          {spinner && <span className="spinner" />}
          {title}
        </h1>
        <p>{sub}</p>
      </div>
      {aside && <div className="aside">{aside}</div>}
    </div>
  )
}

export function Panel({ title, aside, children, className }: { title?: ReactNode; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`m-panel${className ? ` ${className}` : ''}`}>
      {(title || aside) && (
        <div className="m-panel-head">
          {title && <h2>{title}</h2>}
          {aside}
        </div>
      )}
      {children}
    </section>
  )
}

/** A full-width notice: 'info' (neutral), 'warn' or 'error'. */
export function Notice({ kind = 'info', icon, children, action }: { kind?: 'info' | 'warn' | 'error'; icon?: IconName; children: ReactNode; action?: ReactNode }) {
  return (
    <div className={`notice is-${kind}`} role={kind === 'info' ? 'status' : 'alert'}>
      <Icon name={icon ?? (kind === 'info' ? 'info' : kind === 'warn' ? 'circle-alert' : 'shield-alert')} size={14} />
      <div className="notice-body">{children}</div>
      {action}
    </div>
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Progress

export function Bar({ value, tone }: { value: number; tone?: 'warn' }) {
  const pct = Math.max(0, Math.min(100, value))
  return (
    <span className={`bar-track${tone ? ` is-${tone}` : ''}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
      <span className="bar-fill" style={{ width: `${pct}%` }} />
    </span>
  )
}

/** "12,480 of 31,002 messages" over a bar, or "31,002 messages" when done. */
export function PartCell({ count, unit, text, tone, off }: { count: Count | null; unit: string; text?: string; tone?: 'warn'; off?: string }) {
  if (!count) return <span className="part is-off">{off ?? 'Not included'}</span>
  const done = count.done >= count.total
  const u = count.total === 1 ? unit.replace(/s$/, '') : unit
  const label = text ?? (done ? `${num(count.total)} ${u}` : count.done === 0 ? `0 of ${num(count.total)} ${u}` : `${num(count.done)} of ${num(count.total)} ${u}`)
  return (
    <span className={`part${count.done === 0 ? ' is-idle' : ''}`}>
      <span className="part-text" title={label}>
        {label}
      </span>
      <Bar value={count.total ? (count.done / count.total) * 100 : 100} tone={tone} />
    </span>
  )
}

const STATE_LABEL: Record<UserState, string> = {
  waiting: 'Waiting',
  copying: 'Copying',
  slowed: 'Slowed by Google · retrying',
  attention: 'Needs attention',
  paused: 'Paused',
  done: 'Done',
}

export function StateChip({ state }: { state: UserState }) {
  const icon: IconName | null = state === 'done' ? 'check' : state === 'attention' ? 'circle-alert' : state === 'slowed' ? 'hourglass' : state === 'paused' ? 'minus' : null
  return (
    <span className={`state is-${state}`}>
      {state === 'copying' ? <span className="spinner" /> : icon && <Icon name={icon} size={12} />}
      {STATE_LABEL[state]}
    </span>
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Controls

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, copy] = useCopied()
  return (
    <button type="button" className="icon-only" aria-label={copied ? 'Copied' : label} title={copied ? 'Copied' : label} onClick={() => void copy(text)}>
      <Icon name={copied ? 'check' : 'copy'} size={13} />
    </button>
  )
}

/** A text button with a copy icon ("Copy all"). */
export function CopyLink({ text, label }: { text: string; label: string }) {
  const [copied, copy] = useCopied()
  return (
    <button type="button" className="text-btn" onClick={() => void copy(text)}>
      <Icon name={copied ? 'check' : 'copy'} size={12} />
      {copied ? 'Copied' : label}
    </button>
  )
}

export type MenuItem<T extends string> = { value: T; label: string; sub?: string; disabled?: boolean }

/** A button that opens a list of options below it, right-aligned. Closes on Escape or a click elsewhere. */
export function Menu<T extends string>({
  label,
  items,
  value,
  onSelect,
  className,
  buttonLabel,
}: {
  label: ReactNode
  items: MenuItem<T>[]
  value?: T
  onSelect: (value: T) => void
  className?: string
  buttonLabel?: string
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !root.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', close)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', close)
    }
  }, [open])
  return (
    <div className={`menu-wrap${className ? ` ${className}` : ''}`} ref={root}>
      <button type="button" className="select" aria-haspopup="menu" aria-expanded={open} aria-label={buttonLabel} onClick={() => setOpen((o) => !o)}>
        <span className="ellipsis">{label}</span>
        <Icon name="chevron-down" size={12} />
      </button>
      {open && (
        <div className="menu" role="menu">
          {items.map((item) => (
            <button
              key={item.value}
              type="button"
              role="menuitemradio"
              aria-checked={item.value === value}
              disabled={item.disabled}
              onClick={() => {
                setOpen(false)
                onSelect(item.value)
              }}
            >
              <span className="check-slot">{item.value === value && <Icon name="check" size={12} />}</span>
              <span className="menu-text">
                <span>{item.label}</span>
                {item.sub && <small>{item.sub}</small>}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function Toggle({ on, label, onChange, disabled }: { on: boolean; label: string; onChange: (on: boolean) => void; disabled?: boolean }) {
  return (
    <button type="button" className="pill" aria-pressed={on} disabled={disabled} onClick={() => onChange(!on)}>
      {on && <Icon name="check" size={10} />}
      {label}
    </button>
  )
}

export function Checkbox({ checked, onChange, label, indeterminate }: { checked: boolean; onChange: (checked: boolean) => void; label: string; indeterminate?: boolean }) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = !!indeterminate
  }, [indeterminate])
  return <input ref={ref} type="checkbox" className="cb" aria-label={label} checked={checked} onChange={(e) => onChange(e.target.checked)} />
}

export function Dialog({ title, children, actions, onClose }: { title: string; children: ReactNode; actions: ReactNode; onClose: () => void }) {
  useEffect(() => {
    const close = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', close)
    return () => document.removeEventListener('keydown', close)
  }, [onClose])
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
        <h2 id="dialog-title">{title}</h2>
        <div className="dialog-body">{children}</div>
        <div className="dialog-actions">{actions}</div>
      </div>
    </div>
  )
}

/** Re-renders every `ms` while `active`, for polling and countdowns. */
export function useTick(ms: number, active = true): number {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setTick((t) => t + 1), ms)
    return () => clearInterval(id)
  }, [ms, active])
  return tick
}
