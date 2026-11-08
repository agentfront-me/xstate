// 1 · Create account, and sign in.

import { useRef, useState, type FormEvent } from 'react'
import { Icon } from '../components/Icon'
import { api, ApiError, errorMessage, PROGRESS_KEY, saveSession, SITE_URL, writeJson, type Session } from '../lib/core'
import { GoogleButton, Head, Help, PasswordInput, usePending, type Message } from './ui'

export function AccountStep({ resume }: { resume: () => Promise<void> }) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [emailHelp, setEmailHelp] = useState<Message>(null)
  const [formHelp, setFormHelp] = useState<Message>(null)
  const [pending, run] = usePending()
  const emailInput = useRef<HTMLInputElement>(null)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const n = name.trim()
    const e = email.trim()
    setEmailHelp(null)
    if (!n) return setFormHelp({ text: 'Enter your name.' })
    if (!emailInput.current?.checkValidity() || !e) return setFormHelp({ text: 'Enter a valid email address.' })
    if (password.length < 8) return setFormHelp({ text: 'Use at least 8 characters for your password.' })
    setFormHelp(null)

    await run(async () => {
      try {
        const res = await api<Session>('POST', '/auth/register', { name: n, email: e, password })
        saveSession(res)
        writeJson(PROGRESS_KEY, null)
        await resume()
      } catch (err) {
        if (err instanceof ApiError && err.code === 'email_taken') {
          setEmailHelp({
            text: (
              <>
                An account with this email already exists.{' '}
                <a className="link-hi" href="/login">
                  Sign in instead
                </a>
              </>
            ),
          })
        } else setFormHelp({ text: errorMessage(err) })
      }
    })
  }

  return (
    <>
      <a className="back" href={SITE_URL}>
        <Icon name="chevron-left" size={14} />
        Back
      </a>
      <Head title="Create your account" sub="Free email on your own domain, with an AI agent that helps in your inbox." />
      <GoogleButton />
      <form className="stack" id="form" noValidate onSubmit={submit}>
        <label className="field">
          Full name
          <span className="input">
            <input name="name" autoComplete="name" placeholder="Your name" required value={name} onChange={(ev) => setName(ev.target.value)} />
          </span>
        </label>
        <label className="field">
          Email
          <span className="input">
            <input
              ref={emailInput}
              name="email"
              type="email"
              autoComplete="email"
              placeholder="you@yourbusiness.com"
              required
              value={email}
              onChange={(ev) => setEmail(ev.target.value)}
            />
          </span>
        </label>
        <Help id="email-help" message={emailHelp} />
        <label className="field">
          Password
          <PasswordInput value={password} onChange={setPassword} autoComplete="new-password" placeholder="At least 8 characters" minLength={8} />
        </label>
        <Help id="form-help" message={formHelp} />
        <button className="btn btn-primary" type="submit" disabled={pending} aria-busy={pending || undefined}>
          Create account
        </button>
      </form>
      <div className="small muted center">
        Already have an account?{' '}
        <a className="link-hi" href="/login">
          Sign in
        </a>
      </div>
    </>
  )
}

export function LoginStep({ resume }: { resume: () => Promise<void> }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [formHelp, setFormHelp] = useState<Message>(null)
  const [pending, run] = usePending()

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const e = email.trim()
    if (!e || !password) return setFormHelp({ text: 'Enter your email and password.' })
    setFormHelp(null)
    await run(async () => {
      try {
        const res = await api<Session>('POST', '/auth/login', { email: e, password })
        saveSession(res)
        await resume()
      } catch (err) {
        setFormHelp({ text: errorMessage(err) })
      }
    })
  }

  return (
    <>
      <a className="back" href={SITE_URL}>
        <Icon name="chevron-left" size={14} />
        Back
      </a>
      <Head title="Sign in to xstate" sub="Welcome back. Your inbox is where you left it." />
      <GoogleButton />
      <form className="stack" id="form" noValidate onSubmit={submit}>
        <label className="field">
          Email
          <span className="input">
            <input
              name="email"
              type="email"
              autoComplete="email"
              placeholder="you@yourbusiness.com"
              required
              value={email}
              onChange={(ev) => setEmail(ev.target.value)}
            />
          </span>
        </label>
        <label className="field">
          Password
          <PasswordInput value={password} onChange={setPassword} autoComplete="current-password" placeholder="Your password" />
        </label>
        <Help id="form-help" message={formHelp} />
        <button className="btn btn-primary" type="submit" disabled={pending} aria-busy={pending || undefined}>
          Sign in
        </button>
      </form>
      <div className="small muted center">
        New to xstate?{' '}
        <a className="link-hi" href="/signup">
          Create an account
        </a>
      </div>
    </>
  )
}
