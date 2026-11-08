// Small pieces shared by the onboarding steps.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Icon } from '../components/Icon'
import { copyText } from '../lib/core'

export function Head({ title, sub }: { title: string; sub: string }) {
  return (
    <div className="head">
      <h1>{title}</h1>
      <p>{sub}</p>
    </div>
  )
}

export function Back({ onClick, label = 'Back' }: { onClick: () => void; label?: string }) {
  return (
    <a
      className="back"
      href="#"
      onClick={(event) => {
        event.preventDefault()
        onClick()
      }}
    >
      <Icon name="chevron-left" size={14} />
      {label}
    </a>
  )
}

/** A help line: 'error', 'ok' or 'info'. Null hides it. */
export type Message = { text: ReactNode; kind?: 'error' | 'ok' | 'info' } | null

export function Help({ id, message }: { id?: string; message: Message }) {
  const kind = message?.kind ?? 'error'
  return (
    <div className={`help${kind === 'error' ? ' is-error' : ''}`} id={id} role="status" hidden={!message}>
      {message && (
        <>
          <Icon name={kind === 'ok' ? 'circle-check' : 'circle-alert'} size={13} />
          <span>{message.text}</span>
        </>
      )}
    </div>
  )
}

/** Shows a check for 1.5 s after a successful copy. */
export function useCopied(): [boolean, (text: string) => Promise<void>] {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const copy = async (text: string) => {
    if (!(await copyText(text))) return
    setCopied(true)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(false), 1500)
  }
  return [copied, copy]
}

/** A password field with a show/hide button. */
export function PasswordInput(props: { value: string; onChange: (value: string) => void; autoComplete: string; placeholder: string; minLength?: number }) {
  const [show, setShow] = useState(false)
  return (
    <span className="input">
      <input
        name="password"
        type={show ? 'text' : 'password'}
        autoComplete={props.autoComplete}
        placeholder={props.placeholder}
        minLength={props.minLength}
        required
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
      />
      <button type="button" className="icon-btn" aria-label={show ? 'Hide password' : 'Show password'} onClick={() => setShow((s) => !s)}>
        <Icon name={show ? 'eye-off' : 'eye'} />
      </button>
    </span>
  )
}

export function GoogleButton() {
  const [message, setMessage] = useState<Message>(null)
  return (
    <>
      <button
        type="button"
        className="btn"
        onClick={() => setMessage({ text: 'Google sign-in is coming soon. Use your email for now.', kind: 'info' })}
      >
        <span className="google" aria-hidden="true">
          G
        </span>
        Continue with Google
      </button>
      <Help id="google-help" message={message} />
      <div className="or">or</div>
    </>
  )
}

/** Runs `work` with a pending flag, for disabling a button (with aria-busy) while it runs. */
export function usePending(): [boolean, <T>(work: () => Promise<T>) => Promise<T | undefined>] {
  const [pending, setPending] = useState(false)
  const busy = useRef(false)
  const run = async <T,>(work: () => Promise<T>) => {
    if (busy.current) return undefined
    busy.current = true
    setPending(true)
    try {
      return await work()
    } finally {
      busy.current = false
      setPending(false)
    }
  }
  return [pending, run]
}
