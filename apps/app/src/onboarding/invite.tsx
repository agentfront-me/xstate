// Accepting an invite: go.xstate.com/invite/#<token>, the link in the invite email. The token stays in the hash, so
// it never reaches a server log; the API is called with POST.
//
// Someone new to xstate chooses their name and password and lands in the dashboard. Someone who already has an
// account joins with one click, then signs in as usual (the link alone never signs in to an existing account).

import '../styles/onboarding.css'
import { StrictMode, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { api, errorMessage, saveSession, session, SITE_URL, type Session } from '../lib/core'
import { Head, Help, PasswordInput, usePending, type Message } from './ui'

type Invite = {
  email: string
  name: string | null
  organization: { name: string }
  invitedBy: string | null
  role: 'owner' | 'admin' | 'member'
  needsPassword: boolean
}

type Accepted = { organization: { id: string; name: string }; signIn: true } | ({ organization: { id: string; name: string }; signIn: false } & Session)

const token = decodeURIComponent(location.hash.slice(1))
// Out of the address bar (and history) as soon as it's read.
if (token) history.replaceState(null, '', location.pathname)

function InvitePage() {
  const [invite, setInvite] = useState<Invite | null>(null)
  const [error, setError] = useState(token ? '' : 'This link is missing its invite code. Open the link from your invite email again.')
  const [joined, setJoined] = useState<string | null>(null)

  useEffect(() => {
    if (!token) return
    api<{ invite: Invite }>('POST', '/auth/invitations/lookup', { token }, { anonymous: true })
      .then((r) => setInvite(r.invite))
      .catch((err) => setError(errorMessage(err)))
  }, [])

  const done = (result: Accepted) => {
    if (result.signIn) return setJoined(result.organization.name)
    saveSession(result)
    location.assign('/app/')
  }

  let view: ReactNode
  if (error) {
    view = (
      <>
        <Head title="This invite can't be used" sub={error} />
        <a className="btn" href="/login">
          Go to sign in
        </a>
      </>
    )
  } else if (joined) {
    view = (
      <>
        <Head title={`You've joined ${joined}`} sub="Sign in with your xstate account to get started." />
        <a className="btn btn-primary" href="/login">
          Sign in
        </a>
      </>
    )
  } else if (!invite) {
    view = (
      <div className="center">
        <span className="spinner" />
      </div>
    )
  } else if (invite.needsPassword) {
    view = <NewAccount invite={invite} done={done} />
  } else {
    view = <ExistingAccount invite={invite} done={done} />
  }

  return (
    <div className="shell">
      <header className="bar">
        <a className="brand" href={SITE_URL}>
          <span className="mark">x/s</span>xstate
        </a>
        <span className="step">Invite</span>
      </header>
      <main>
        <div className="col">{view}</div>
      </main>
    </div>
  )
}

function invitedLine(invite: Invite) {
  const who = invite.invitedBy ?? 'Someone'
  const as = invite.role === 'admin' ? ' as an admin' : ''
  return `${who} invited ${invite.email} to ${invite.organization.name}${as}.`
}

function NewAccount({ invite, done }: { invite: Invite; done: (r: Accepted) => void }) {
  const [name, setName] = useState(invite.name ?? '')
  const [password, setPassword] = useState('')
  const [help, setHelp] = useState<Message>(null)
  const [pending, run] = usePending()

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!name.trim()) return setHelp({ text: 'Enter your name.' })
    if (password.length < 8) return setHelp({ text: 'Use at least 8 characters for your password.' })
    setHelp(null)
    await run(async () => {
      try {
        done(await api<Accepted>('POST', '/auth/invitations/accept', { token, name: name.trim(), password }, { anonymous: true }))
      } catch (err) {
        setHelp({ text: errorMessage(err) })
      }
    })
  }

  return (
    <>
      <Head title={`Join ${invite.organization.name}`} sub={`${invitedLine(invite)} Choose a password to finish.`} />
      <form className="stack" noValidate onSubmit={submit}>
        <label className="field">
          Email
          <span className="input">
            <input name="email" type="email" autoComplete="username" value={invite.email} readOnly />
          </span>
        </label>
        <label className="field">
          Full name
          <span className="input">
            <input name="name" autoComplete="name" placeholder="Your name" required value={name} onChange={(e) => setName(e.target.value)} />
          </span>
        </label>
        <label className="field">
          Password
          <PasswordInput value={password} onChange={setPassword} autoComplete="new-password" placeholder="At least 8 characters" minLength={8} />
        </label>
        <Help message={help} />
        <button className="btn btn-primary" type="submit" disabled={pending} aria-busy={pending || undefined}>
          Join {invite.organization.name}
        </button>
      </form>
    </>
  )
}

function ExistingAccount({ invite, done }: { invite: Invite; done: (r: Accepted) => void }) {
  const [help, setHelp] = useState<Message>(null)
  const [pending, run] = usePending()
  const join = () =>
    run(async () => {
      try {
        done(await api<Accepted>('POST', '/auth/invitations/accept', { token }, { anonymous: true }))
      } catch (err) {
        setHelp({ text: errorMessage(err) })
      }
    })

  return (
    <>
      <Head
        title={`Join ${invite.organization.name}`}
        sub={`${invitedLine(invite)} You already have an xstate account${session() ? '' : ', so you’ll sign in with it after joining'}.`}
      />
      <Help message={help} />
      <button className="btn btn-primary" disabled={pending} aria-busy={pending || undefined} onClick={() => void join()}>
        Join {invite.organization.name}
      </button>
    </>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <InvitePage />
  </StrictMode>,
)
