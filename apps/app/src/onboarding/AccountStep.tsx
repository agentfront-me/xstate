// 1 · Create account, and sign in.

import { useRef, useState, type FormEvent } from 'react'
import { Icon } from '../components/Icon'
import { api, ApiError, errorMessage, PROGRESS_KEY, saveSession, SITE_URL, writeJson, type Session } from '../lib/core'
import { Head, Help, PasswordInput, usePending, type Message } from './ui'

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
  // Signed in with a temporary password an admin set: they choose their own before going in.
  const [changeToken, setChangeToken] = useState<string | null>(null)

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
        if (err instanceof ApiError && err.code === 'password_change_required' && typeof err.details?.changeToken === 'string') {
          setPassword('')
          return setChangeToken(err.details.changeToken)
        }
        setFormHelp({ text: errorMessage(err) })
      }
    })
  }

  if (changeToken) return <NewPasswordStep email={email.trim()} changeToken={changeToken} resume={resume} restart={() => setChangeToken(null)} />

  return (
    <>
      <a className="back" href={SITE_URL}>
        <Icon name="chevron-left" size={14} />
        Back
      </a>
      <Head title="Sign in to xstate" sub="Welcome back. Your inbox is where you left it." />
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

/** After signing in with a temporary password: choose your own, then you're in. */
function NewPasswordStep({ email, changeToken, resume, restart }: { email: string; changeToken: string; resume: () => Promise<void>; restart: () => void }) {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [formHelp, setFormHelp] = useState<Message>(null)
  const [pending, run] = usePending()

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (password.length < 8) return setFormHelp({ text: 'Use at least 8 characters for your password.' })
    if (password !== confirm) return setFormHelp({ text: "The two passwords don't match." })
    setFormHelp(null)
    await run(async () => {
      try {
        saveSession(await api<Session>('POST', '/auth/password/change', { changeToken, password }))
        await resume()
      } catch (err) {
        if (err instanceof ApiError && err.code === 'invalid_token') return restart()
        setFormHelp({ text: errorMessage(err) })
      }
    })
  }

  return (
    <>
      <Head title="Choose your password" sub={`You signed in to ${email} with a temporary password. Choose your own to continue.`} />
      <form className="stack" id="form" noValidate onSubmit={submit}>
        <input type="email" name="email" autoComplete="username" value={email} readOnly hidden />
        <label className="field">
          New password
          <PasswordInput value={password} onChange={setPassword} autoComplete="new-password" placeholder="At least 8 characters" minLength={8} />
        </label>
        <label className="field">
          Repeat it
          <PasswordInput value={confirm} onChange={setConfirm} autoComplete="new-password" placeholder="The same password" minLength={8} />
        </label>
        <Help id="form-help" message={formHelp} />
        <button className="btn btn-primary" type="submit" disabled={pending} aria-busy={pending || undefined}>
          Continue
        </button>
      </form>
    </>
  )
}
