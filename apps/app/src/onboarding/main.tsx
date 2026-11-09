// Sign-in and onboarding: /login and /signup. One step at a time.
//
// Steps: 1 create account → 2 your domain → 3 verify domain → 4 create addresses → 5 connect agent → done.
// After sign-in the step comes from the account itself (domain added? verified? mailboxes?), so a reload or a
// later sign-in resumes where the person left off. Choices the API doesn't store yet (skipping verification,
// finishing step 5) are kept in localStorage.

import '../styles/onboarding.css'
import { StrictMode, useCallback, useEffect, useState, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { api, ApiError, errorMessage, session, SITE_URL } from '../lib/core'
import type { Domain, Mailbox, Org, User } from '../lib/types'
import { AccountStep, LoginStep } from './AccountStep'
import { AddressesStep } from './AddressesStep'
import { AgentStep, DoneStep } from './AgentStep'
import { DomainStep } from './DomainStep'
import { progress, readConnectReturn, STEP_LABELS, type Data, type Screen } from './state'
import { Head } from './ui'
import { VerifyStep } from './VerifyStep'

readConnectReturn()

const onLogin = () => location.pathname.startsWith('/login')

function Onboarding() {
  const [screen, setScreen] = useState<Screen>('loading')
  const [data, setData] = useState<Data | null>(null)
  const [error, setError] = useState('')

  const update = useCallback((patch: Partial<Data>) => setData((d) => (d ? { ...d, ...patch } : d)), [])

  /** Loads the account and works out which step comes next. */
  const resume = useCallback(async () => {
    const me = await api<{ user: User; organizations: Org[] }>('GET', '/auth/me')
    const org = me.organizations.find((o) => o.role === 'owner') ?? me.organizations[0]
    if (!org) throw new Error('Your account has no organization.')
    // Someone invited to another organization: setting up domains is its owner's job, so straight to the dashboard.
    if (org.role !== 'owner') return location.assign('/app/')
    const [{ domains }, { mailboxes }] = await Promise.all([
      api<{ domains: Domain[] }>('GET', `/email/orgs/${org.id}/domains`),
      api<{ mailboxes: Mailbox[] }>('GET', `/email/orgs/${org.id}/mailboxes`),
    ])
    const next: Data = { user: me.user, org, domain: domains[0] ?? null, mailboxes }
    const p = progress()

    // Signing in to an account that already has addresses: go straight to the dashboard. Onboarding is for new
    // accounts, and a new device (the desktop app) has no local progress to resume.
    if (onLogin() && next.domain && next.mailboxes.length) return location.assign('/app/')
    if (onLogin()) {
      history.replaceState(null, '', '/signup')
      document.title = 'Set up · xstate'
    }
    setData(next)
    if (!next.domain) return setScreen('domain')
    if (next.domain.status !== 'verified' && p.skippedVerify !== next.domain.id && !next.mailboxes.length) return setScreen('verify')
    if (!next.mailboxes.length) return setScreen('addresses')
    if (!p.finished) return setScreen('agent')
    setScreen('done')
  }, [])

  const start = useCallback(async () => {
    if (!session()) return setScreen(onLogin() ? 'login' : 'account')
    try {
      await resume()
    } catch (err) {
      if (err instanceof ApiError && err.code === 'signed_out') return
      setError(errorMessage(err))
      setScreen('error')
    }
  }, [resume])

  useEffect(() => {
    void start()
  }, [start])

  useEffect(() => {
    window.scrollTo(0, 0)
  }, [screen])

  const go = (s: Screen) => () => setScreen(s)

  let view: ReactNode = null
  if (screen === 'account') view = <AccountStep resume={resume} />
  else if (screen === 'login') view = <LoginStep resume={resume} />
  else if (screen === 'error')
    view = (
      <>
        <Head title="Something's not right" sub={error} />
        <button className="btn" id="retry" onClick={() => void start()}>
          Try again
        </button>
      </>
    )
  else if (data) {
    if (screen === 'domain') view = <DomainStep data={data} update={update} next={go('verify')} />
    else if (screen === 'verify' && data.domain)
      view = <VerifyStep key={data.domain.id} data={data} update={update} back={go('domain')} next={go('addresses')} />
    else if (screen === 'addresses') view = <AddressesStep data={data} update={update} back={go('verify')} next={go('agent')} />
    else if (screen === 'agent') view = <AgentStep data={data} back={go('addresses')} next={go('done')} />
    else if (screen === 'done') view = <DoneStep data={data} verify={go('verify')} agent={go('agent')} />
  }

  return (
    <div className="shell">
      <header className="bar">
        <a className="brand" href={SITE_URL}>
          <span className="mark">x/s</span>xstate
        </a>
        <span className="step" id="step">
          {STEP_LABELS[screen]}
        </span>
      </header>
      <main>
        <div className="col" id="view">
          {view}
        </div>
      </main>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Onboarding />
  </StrictMode>,
)
