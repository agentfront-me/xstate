// Choosing a new password from the link an admin emailed: go.xstate.com/reset/#<token>. Like the invite page, the
// token stays in the hash (never in a server log) and the API is called with POST. Done, they're signed in.

import '../styles/onboarding.css'
import { StrictMode, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { api, errorMessage, saveSession, SITE_URL, type Session } from '../lib/core'
import { Head, Help, PasswordInput, usePending, type Message } from './ui'

const token = (() => {
  try {
    return decodeURIComponent(location.hash.slice(1))
  } catch {
    return ''
  }
})()
if (token) history.replaceState(null, '', location.pathname)

function ResetPage() {
  const [account, setAccount] = useState<{ email: string } | null>(null)
  const [error, setError] = useState(token ? '' : 'This link is missing its code. Open the link from your email again.')

  useEffect(() => {
    if (!token) return
    api<{ reset: { email: string } }>('POST', '/auth/password-reset/lookup', { token }, { anonymous: true })
      .then((r) => setAccount(r.reset))
      .catch((err) => setError(errorMessage(err)))
  }, [])

  let view: ReactNode
  if (error) {
    view = (
      <>
        <Head title="This link can't be used" sub={error} />
        <a className="btn" href="/login">
          Go to sign in
        </a>
      </>
    )
  } else if (!account) {
    view = (
      <div className="center">
        <span className="spinner" />
      </div>
    )
  } else {
    view = <NewPassword email={account.email} />
  }

  return (
    <div className="shell">
      <header className="bar">
        <a className="brand" href={SITE_URL}>
          <span className="mark">x/s</span>xstate
        </a>
        <span className="step">Password</span>
      </header>
      <main>
        <div className="col">{view}</div>
      </main>
    </div>
  )
}

function NewPassword({ email }: { email: string }) {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [help, setHelp] = useState<Message>(null)
  const [pending, run] = usePending()

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (password.length < 8) return setHelp({ text: 'Use at least 8 characters for your password.' })
    if (password !== confirm) return setHelp({ text: "The two passwords don't match." })
    setHelp(null)
    await run(async () => {
      try {
        saveSession(await api<Session>('POST', '/auth/password-reset/complete', { token, password }, { anonymous: true }))
        location.assign('/app/')
      } catch (err) {
        setHelp({ text: errorMessage(err) })
      }
    })
  }

  return (
    <>
      <Head title="Choose a new password" sub={`For ${email}. You'll be signed in when it's saved.`} />
      <form className="stack" noValidate onSubmit={submit}>
        <input type="email" name="email" autoComplete="username" value={email} readOnly hidden />
        <label className="field">
          New password
          <PasswordInput value={password} onChange={setPassword} autoComplete="new-password" placeholder="At least 8 characters" minLength={8} />
        </label>
        <label className="field">
          Repeat it
          <PasswordInput value={confirm} onChange={setConfirm} autoComplete="new-password" placeholder="The same password" minLength={8} />
        </label>
        <Help message={help} />
        <button className="btn btn-primary" type="submit" disabled={pending} aria-busy={pending || undefined}>
          Save and sign in
        </button>
      </form>
    </>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ResetPage />
  </StrictMode>,
)
