// Connecting an AI app (Claude, Cursor, ChatGPT…) over MCP: go.xstate.com/connect/#<request>. The app sends the
// person to mcp.xstate.com/authorize, which checks the request and redirects here with its id. This page shows who
// is asking and where the access goes, lets the person pick what the app may do, and sends them back to the app.
// The request id works once, for 10 minutes, and only together with the person's own session.

import '../styles/onboarding.css'
import { StrictMode, useCallback, useEffect, useState, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { Icon } from '../components/Icon'
import { api, errorMessage, session, signOut, SITE_URL } from '../lib/core'
import { LoginStep } from './AccountStep'
import { Head, Help, usePending, type Message } from './ui'

type Level = 'off' | 'read' | 'write'
type Mailbox = { id: string; address: string; kind: 'personal' | 'shared' | 'agent'; name: string | null }
type Organization = { id: string; name: string; canSetup: boolean; mailboxes: Mailbox[] }
type Details = {
  app: { name: string; domain: string | null; redirectHost: string; local: boolean }
  user: { email: string }
  organizations: Organization[]
}

const requestId = location.hash.slice(1)

const EMAIL_LEVELS: { value: 'read' | 'draft' | 'send'; label: string; hint: string }[] = [
  { value: 'read', label: 'Read only', hint: 'It can read and search your mail, nothing else.' },
  { value: 'draft', label: 'Draft only', hint: 'It can also write drafts and file messages. You send.' },
  { value: 'send', label: 'Draft and send', hint: 'It can send mail from these addresses on its own.' },
]
const AREAS: { key: 'calendar' | 'storage' | 'contacts'; label: string }[] = [
  { key: 'calendar', label: 'Calendar' },
  { key: 'storage', label: 'Storage' },
  { key: 'contacts', label: 'Contacts' },
]

function ConnectPage() {
  const [signedIn, setSignedIn] = useState(() => !!session())
  const [details, setDetails] = useState<Details | null>(null)
  const [error, setError] = useState(requestId ? '' : 'This page opens when an app asks to connect to xstate. Start from the app you want to connect.')
  const [leaving, setLeaving] = useState(false)

  const load = useCallback(async () => {
    setSignedIn(true)
    try {
      setDetails(await api<Details>('GET', `/connect/requests/${encodeURIComponent(requestId)}`))
    } catch (err) {
      setError(errorMessage(err))
    }
  }, [])

  useEffect(() => {
    if (requestId && session()) void load()
  }, [load])

  let view: ReactNode
  if (error) {
    view = <Head title="This request can't be used" sub={error} />
  } else if (!signedIn) {
    view = <LoginStep resume={load} />
  } else if (leaving) {
    view = <Head title="Taking you back to the app" sub="You can close this tab if nothing happens." />
  } else if (!details) {
    view = (
      <div className="center">
        <span className="spinner" />
      </div>
    )
  } else if (!details.organizations.length) {
    view = <Head title="Nothing to connect yet" sub="Your account isn't in an organization. Finish setting up xstate, then connect the app again." />
  } else {
    view = <Consent details={details} leave={() => setLeaving(true)} />
  }

  return (
    <div className="shell">
      <header className="bar">
        <a className="brand" href={SITE_URL}>
          <span className="mark">x/s</span>xstate
        </a>
        <span className="step">Connect an app</span>
      </header>
      <main>
        <div className="col">{view}</div>
      </main>
    </div>
  )
}

function Consent({ details, leave }: { details: Details; leave: () => void }) {
  const { app } = details
  const [organizationId, setOrganizationId] = useState(details.organizations[0]!.id)
  const organization = details.organizations.find((o) => o.id === organizationId)!
  // Your own mailbox to start with; shared ones are for you to add.
  const personal = (o: Organization) => o.mailboxes.filter((m) => m.kind === 'personal').map((m) => m.id)
  const [mailboxIds, setMailboxIds] = useState(() => personal(organization))
  const [email, setEmail] = useState<'read' | 'draft' | 'send'>('draft')
  const [levels, setLevels] = useState<Record<'calendar' | 'storage' | 'contacts', Level>>({ calendar: 'read', storage: 'read', contacts: 'read' })
  const [setup, setSetup] = useState(false)
  const [help, setHelp] = useState<Message>(null)
  const [pending, run] = usePending()

  const answer = (decision: 'approve' | 'deny') =>
    run(async () => {
      setHelp(null)
      try {
        const body = decision === 'approve' ? { organizationId, mailboxIds, email, ...levels, setup: setup && organization.canSetup } : undefined
        const { redirectTo } = await api<{ redirectTo: string }>('POST', `/connect/requests/${encodeURIComponent(requestId)}/${decision}`, body)
        leave()
        location.assign(redirectTo)
      } catch (err) {
        setHelp({ text: errorMessage(err) })
      }
    })

  return (
    <>
      <Head
        title={`Connect ${app.name} to xstate`}
        sub={
          (app.domain ? `Published by ${app.domain}. ` : 'This app gave its own name; xstate could not check who made it. ') +
          `Access will be sent to ${app.redirectHost}.`
        }
      />
      {app.local && (
        <div className="tip">
          <Icon name="shield-alert" size={14} />
          <span>This sends access to an app on this computer. Continue only if you just started connecting from it.</span>
        </div>
      )}
      <div className="panel">
        {details.organizations.length > 1 && (
          <fieldset className="panel-section">
            <legend>Organization</legend>
            {details.organizations.map((o) => (
              <label className="option" key={o.id}>
                <input
                  type="radio"
                  name="organization"
                  checked={o.id === organizationId}
                  onChange={() => {
                    setOrganizationId(o.id)
                    setMailboxIds(personal(o))
                    setSetup(false)
                  }}
                />
                <span className="radio" />
                {o.name}
              </label>
            ))}
          </fieldset>
        )}
        <fieldset className="panel-section">
          <legend>Mailboxes it can use</legend>
          {organization.mailboxes.length === 0 && <span className="small muted">You have no mailboxes in this organization yet.</span>}
          {organization.mailboxes.map((m) => (
            <label className="option" key={m.id}>
              <input
                type="checkbox"
                name="mailbox"
                checked={mailboxIds.includes(m.id)}
                onChange={(event) => setMailboxIds(event.target.checked ? [...mailboxIds, m.id] : mailboxIds.filter((id) => id !== m.id))}
              />
              <span className="box">
                <Icon name="check" size={12} />
              </span>
              <span>
                {m.address}
                {m.kind !== 'personal' && <small>{m.kind === 'shared' ? 'Shared mailbox' : 'Agent mailbox'}</small>}
              </span>
            </label>
          ))}
        </fieldset>
        <fieldset className="panel-section">
          <legend>Email</legend>
          {EMAIL_LEVELS.map((level) => (
            <label className="option" key={level.value}>
              <input type="radio" name="email" checked={email === level.value} onChange={() => setEmail(level.value)} />
              <span className="radio" />
              <span>
                {level.label}
                <small>{level.hint}</small>
              </span>
            </label>
          ))}
        </fieldset>
        <div className="panel-section">
          {AREAS.map((area) => (
            <label className="level" key={area.key}>
              {area.label}
              <select value={levels[area.key]} onChange={(event) => setLevels({ ...levels, [area.key]: event.target.value as Level })}>
                <option value="off">Off</option>
                <option value="read">Read</option>
                <option value="write">Read and change</option>
              </select>
            </label>
          ))}
        </div>
        {organization.canSetup && (
          <fieldset className="panel-section">
            <legend>Setup</legend>
            <label className="option">
              <input type="checkbox" name="setup" checked={setup} onChange={(event) => setSetup(event.target.checked)} />
              <span className="box">
                <Icon name="check" size={12} />
              </span>
              <span>
                Manage domains and mailboxes
                <small>Add and remove domains, mailboxes and aliases. Leave off unless you need it.</small>
              </span>
            </label>
          </fieldset>
        )}
      </div>
      <Help message={help} />
      <button className="btn btn-primary" id="allow" disabled={pending} aria-busy={pending || undefined} onClick={() => void answer('approve')}>
        Allow {app.name}
      </button>
      <button className="btn" id="deny" disabled={pending} onClick={() => void answer('deny')}>
        Cancel
      </button>
      <span className="link">
        Signed in as {details.user.email}.{' '}
        <a
          className="link-hi"
          href="/login"
          onClick={(event) => {
            event.preventDefault()
            signOut()
          }}
        >
          Not you?
        </a>
      </span>
    </>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ConnectPage />
  </StrictMode>,
)
