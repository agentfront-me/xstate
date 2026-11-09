// Import from Google Workspace: /migrate/. The same focused shell as account creation (xstate header with the step
// count, one centered column, Back to Settings), wider because the plan and progress screens are tables.
//
// Entry points: Settings → Migration, and a card under the domain step of onboarding. The step comes from the
// migration itself, so a reload or a visit days later lands where it left off. Only owners and admins run a
// migration; other members see a view-only page.

import '../styles/onboarding.css'
import '../styles/migration.css'
import { StrictMode, useCallback, useEffect, useState, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { Icon } from '../components/Icon'
import { isDemo } from '../lib/account'
import { api, ApiError, applyTheme, errorMessage, session } from '../lib/core'
import { sampleOrg } from '../lib/sample'
import type { Domain, Mailbox, Org, User } from '../lib/types'
import * as migrationApi from './api'
import { ConnectStep } from './steps/Connect'
import { CopyingStep } from './steps/Copying'
import { DiscoverStep } from './steps/Discover'
import { DoneStep, FinishStep } from './steps/Finish'
import { FinalStep } from './steps/Final'
import { PlanStep } from './steps/Plan'
import { ReviewStep } from './steps/Review'
import { SwitchStep } from './steps/Switch'
import { stepIndex, STEPS, type Migration, type Stage } from './types'
import { StepBar } from './ui'

applyTheme()

/** What every step gets. */
export type Ctx = {
  user: User
  org: Org
  /** The organization's first domain in xstate (a placeholder until Google says which domain the Workspace has). */
  domain: string
  /** Every domain the organization has in xstate. */
  domains: string[]
  mailboxes: Mailbox[]
  migration: Migration
  setMigration: (m: Migration) => void
  go: (stage: Stage) => Promise<void>
  isAdmin: boolean
  demo: boolean
}

type Loaded = Omit<Ctx, 'migration' | 'setMigration' | 'go'>

const settingsUrl = (demo: boolean) => `/app/${demo ? '?demo' : ''}#/settings/migration`

async function loadAccount(): Promise<Loaded> {
  // Demo mode (?demo) matches the dashboard's: sample organization, no sign-in needed, even when signed in.
  const demo = isDemo()
  if (demo) {
    return {
      user: { id: 'demo', name: 'Dana Whitfield', email: 'admin@acme-co.com' },
      org: { id: sampleOrg.id, name: 'Acme Co', role: 'owner' },
      domain: 'acme-co.com',
      domains: ['acme-co.com'],
      mailboxes: [],
      isAdmin: true,
      demo,
    }
  }
  if (!session()) {
    location.assign('/login')
    throw new ApiError('signed_out', 'Sign in to continue.', 401)
  }
  const me = await api<{ user: User; organizations: Org[] }>('GET', '/auth/me')
  const org = me.organizations.find((o) => o.role === 'owner') ?? me.organizations[0]
  if (!org) throw new Error('Your account has no organization.')
  const [{ domains }, { mailboxes }] = await Promise.all([
    api<{ domains: Domain[] }>('GET', `/email/orgs/${org.id}/domains`),
    api<{ mailboxes: Mailbox[] }>('GET', `/email/orgs/${org.id}/mailboxes`),
  ])
  return {
    user: me.user,
    org,
    domain: domains[0]?.name ?? 'yourcompany.com',
    domains: domains.map((d) => d.name),
    mailboxes,
    isAdmin: org.role === 'owner' || org.role === 'admin',
    demo,
  }
}

function Migrate() {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [migration, setMigration] = useState<Migration | null>(null)
  const [error, setError] = useState('')

  const start = useCallback(async () => {
    setError('')
    try {
      const account = await loadAccount()
      const m = await migrationApi.load(account.org.id, { name: account.user.name ?? account.user.email, email: account.user.email })
      setLoaded(account)
      setMigration(m)
    } catch (err) {
      if (err instanceof ApiError && err.code === 'signed_out') return
      setError(errorMessage(err))
    }
  }, [])

  useEffect(() => {
    void start()
  }, [start])

  const stage = migration?.stage
  useEffect(() => {
    window.scrollTo(0, 0)
    if (stage) document.title = `${stage === 'done' ? 'Done' : STEPS[stepIndex(stage)]!.label} · Import from Google Workspace · xstate`
  }, [stage])

  const go = useCallback(
    async (next: Stage) => {
      if (!loaded) return
      setMigration(await migrationApi.setStage(loaded.org.id, next))
    },
    [loaded],
  )

  let view: ReactNode
  let right = ''
  if (error) {
    view = (
      <div className="m-col narrow">
        <div className="head">
          <h1>Something's not right</h1>
          <p>{error}</p>
        </div>
        <button className="btn" onClick={() => void start()}>
          Try again
        </button>
      </div>
    )
  } else if (!loaded || !migration) {
    view = (
      <div className="m-col narrow loading">
        <span className="spinner" />
      </div>
    )
  } else if (!loaded.isAdmin && migration.stage === 'connect') {
    right = 'View only'
    view = (
      <div className="m-col">
        <a className="back" href={settingsUrl(loaded.demo)}>
          <Icon name="chevron-left" size={14} />
          Back to Settings
        </a>
        <StepBar stage="connect" />
        <div className="empty-state">
          <span className="empty-icon">
            <Icon name="lock" size={18} />
          </span>
          <h1>Only organization admins can run a migration</h1>
          <p>Ask an owner or admin of {loaded.org.name} to import your Google Workspace.</p>
        </div>
      </div>
    )
  } else {
    const ctx: Ctx = { ...loaded, migration, setMigration, go }
    const s = migration.stage
    right = s === 'done' ? 'Done' : !loaded.isAdmin ? 'View only' : `Step ${stepIndex(s) + 1} of ${STEPS.length}`
    const body =
      s === 'connect' ? <ConnectStep ctx={ctx} />
      : s === 'discover' ? <DiscoverStep ctx={ctx} />
      : s === 'plan' ? <PlanStep ctx={ctx} />
      : s === 'review' ? <ReviewStep ctx={ctx} />
      : s === 'copying' ? <CopyingStep ctx={ctx} />
      : s === 'switch' ? <SwitchStep ctx={ctx} />
      : s === 'final' ? <FinalStep ctx={ctx} />
      : s === 'finish' ? <FinishStep ctx={ctx} />
      : <DoneStep ctx={ctx} />
    view = (
      <div className="m-col">
        <a className="back" href={settingsUrl(loaded.demo)}>
          <Icon name="chevron-left" size={14} />
          Back to Settings
        </a>
        <StepBar stage={s} />
        {body}
      </div>
    )
  }

  const copying = migration?.stage === 'copying'
  return (
    <div className="shell">
      <header className="bar">
        <span className="brand-row">
          <a className="brand" href={loaded ? settingsUrl(loaded.demo) : '/app/'}>
            <span className="mark">x/s</span>xstate
          </a>
          <span className="crumb">· Import from Google Workspace</span>
        </span>
        <span className="step">
          {right === 'View only' && <Icon name="eye" size={12} />}
          {right}
        </span>
      </header>
      {copying && <div id="banner-slot" />}
      <main>{view}</main>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Migrate />
  </StrictMode>,
)
