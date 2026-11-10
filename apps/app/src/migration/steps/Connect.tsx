// 1 · Connect: instructions on the left (copied into the Google Admin console), verification on the right.
// Continue appears only when all four permission checks pass.

import { useState, type FormEvent } from 'react'
import { Icon } from '../../components/Icon'
import { RecordCell } from '../../components/RecordCell'
import { ApiError, errorMessage, isEmail } from '../../lib/core'
import { Help, usePending, type Message } from '../../onboarding/ui'
import * as migrationApi from '../api'
import type { Ctx } from '../main'
import type { Connection } from '../types'
import { CopyButton, CopyLink, Panel, Title } from '../ui'

/** From the API's domain_not_owned error (migration/service.ts requireOwnDomains). */
type OwnershipRecord = { domain: string; type: string; name: string; value: string }

/** Google Admin's Domain-wide delegation page (Security → API controls), for the signed-in super admin. */
const DELEGATION_URL = 'https://admin.google.com/ac/owl/domainwidedelegation'

export function ConnectStep({ ctx }: { ctx: Ctx }) {
  // Read at render: the API's scope list replaces the demo one once the migration loads.
  const ALL_SCOPES = migrationApi.SCOPES.map((s) => s.url).join(',')
  const [email, setEmail] = useState(ctx.migration.connection?.adminEmail ?? (ctx.isAdmin ? ctx.user.email : ''))
  const [connection, setConnection] = useState<Connection | null>(ctx.migration.connection)
  const [message, setMessage] = useState<Message>(null)
  // The ownership TXT records to add, when Verify says the admin's domain isn't proven to be this organization's.
  const [ownership, setOwnership] = useState<OwnershipRecord[]>([])
  const [pending, run] = usePending()
  const passed = migrationApi.allPassed(connection)
  const failed = connection ? migrationApi.SCOPES.filter((s) => !connection.checks[s.id]).length : 0

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const value = email.trim().toLowerCase()
    if (!isEmail(value)) return setMessage({ text: 'Enter the email address of a Google Workspace super admin.' })
    setMessage(null)
    await run(async () => {
      try {
        setConnection(await migrationApi.verify(ctx.org.id, value))
        setOwnership([])
      } catch (err) {
        const records = err instanceof ApiError && err.code === 'domain_not_owned' ? ((err.details?.records as OwnershipRecord[] | undefined) ?? []) : []
        setOwnership(records)
        setMessage({ text: records.length ? `Prove ${records.map((r) => r.domain).join(' and ')} ${records.length === 1 ? 'is' : 'are'} yours first. Mail keeps going to Google until you switch.` : errorMessage(err) })
      }
    })
  }

  return (
    <>
      <Title
        title="Connect your Google Workspace"
        sub="You give xstate read-only access to your Workspace through domain-wide delegation. We copy mail, contacts, calendars and Drive files to xstate. Nothing in Google is changed or deleted, and you can remove the access at any time."
      />
      <div className="two-col">
        <Panel
          title="In the Google Admin console"
          aside={
            <a className="text-btn" href="https://support.google.com/a/answer/162106" target="_blank" rel="noreferrer">
              Visual guide (2 min)
              <Icon name="external-link" size={12} />
            </a>
          }
        >
          <ol className="howto">
            <li>
              <span>
                Open{' '}
                <a href={DELEGATION_URL} target="_blank" rel="noreferrer">
                  <b>Domain-wide delegation</b>
                  <Icon name="external-link" size={12} />
                </a>{' '}
                in the Google Admin console, then click Add new.
                <span className="howto-alt muted small">
                  Or in admin.google.com: Show more → Security → Access and data control → API controls → Manage Domain Wide Delegation.
                </span>
              </span>
            </li>
            <li>
              <span>Paste xstate's Client ID, then paste the scopes below (comma-separated) and click Authorize.</span>
            </li>
            <li>
              <span>Come back here and verify with a super admin email.</span>
            </li>
          </ol>
          <div className="field-label">Client ID</div>
          <div className="code-row">
            <code>{migrationApi.CLIENT_ID}</code>
            <CopyButton text={migrationApi.CLIENT_ID} label="Copy Client ID" />
          </div>
          <div className="field-label row">
            <span>OAuth scopes · all read-only</span>
            <CopyLink text={ALL_SCOPES} label="Copy all" />
          </div>
          <div className="scope-table">
            {migrationApi.SCOPES.map((s) => (
              <div className="scope" key={s.id}>
                <span className="scope-name">{s.label}</span>
                <code title={s.url}>{s.url}</code>
                <CopyButton text={s.url} label={`Copy ${s.label} scope`} />
              </div>
            ))}
          </div>
        </Panel>

        <div className="stack">
          <Panel title="Then verify the connection">
            <form className="verify-form" noValidate onSubmit={submit}>
              <label className="field" htmlFor="admin-email">
                <span className="hi">Google Workspace admin email</span>
                <span>A super admin account. xstate acts as this user to read the directory.</span>
              </label>
              <div className="inline-form">
                <span className={`input on-panel${message ? ' is-error' : ''}`}>
                  <input
                    id="admin-email"
                    type="email"
                    autoComplete="email"
                    placeholder={`admin@${ctx.domain}`}
                    value={email}
                    disabled={!ctx.isAdmin}
                    onChange={(e) => {
                      setEmail(e.target.value)
                      setMessage(null)
                    }}
                  />
                </span>
                <button className="btn btn-primary btn-auto" type="submit" disabled={pending || !ctx.isAdmin} aria-busy={pending || undefined}>
                  {pending && <span className="spinner spinner-on-primary" />}
                  {pending ? 'Verifying…' : connection ? 'Verify again' : 'Verify'}
                </button>
              </div>
              <Help message={message} />
              {ownership.length > 0 && (
                <div className="ownership">
                  <p className="small muted">
                    At your DNS host, add this TXT record, then verify again. It only proves the domain is yours: mail isn’t moved until the Switch step.
                  </p>
                  {ownership.map((r) => (
                    <div key={r.domain} className="scope-table">
                      <div className="scope">
                        <span className="scope-name">Domain</span>
                        <code>{r.domain}</code>
                        <span />
                      </div>
                      <div className="scope">
                        <span className="scope-name">Type · Name</span>
                        <code>TXT · @</code>
                        <span />
                      </div>
                      <div className="scope">
                        <span className="scope-name">Value</span>
                        <RecordCell label="TXT value" text={r.value} />
                        <CopyButton text={r.value} label="Copy TXT value" />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </form>
            <ul className="checks">
              {migrationApi.SCOPES.map((s) => {
                const state = pending ? 'checking' : !connection ? 'idle' : connection.checks[s.id] ? 'passed' : 'failed'
                return (
                  <li key={s.id} className={`check is-${state}`}>
                    {state === 'checking' ? (
                      <span className="spinner" />
                    ) : (
                      <Icon name={state === 'passed' ? 'circle-check' : state === 'failed' ? 'circle-alert' : 'circle'} size={14} />
                    )}
                    <span className="check-name">{s.label}</span>
                    <span className="check-detail">{state === 'idle' ? 'Checked after you verify' : state === 'checking' ? 'Checking…' : s.detail}</span>
                    {(state === 'passed' || state === 'failed') && <span className="check-state">{state === 'passed' ? 'Passed' : 'Failed'}</span>}
                  </li>
                )
              })}
            </ul>
          </Panel>

          {connection && !pending && failed > 0 && (
            <div className="causes" role="alert">
              <div className="causes-head">
                <Icon name="circle-alert" size={14} />
                {failed} of {migrationApi.SCOPES.length} permissions failed. Two common causes:
              </div>
              <ol>
                <li>
                  <b>A scope was mistyped.</b> In Domain-wide delegation, open the entry for Client ID {migrationApi.CLIENT_ID.slice(0, 6)}…
                  {migrationApi.CLIENT_ID.slice(-4)} and compare the scopes with the list on the left. Use "Copy all" and paste them in one go.
                </li>
                <li>
                  <b>The app is blocked.</b> Go to Security → API controls → App access control → Manage third-party app access, find "xstate"
                  and set it to Trusted.
                </li>
              </ol>
              <p className="muted small">Changes in Google can take up to 10 minutes to apply. Verify again after that.</p>
            </div>
          )}

          {passed && !pending && (
            <div className="actions">
              <button className="btn btn-primary btn-auto" onClick={() => void ctx.go('discover')}>
                Continue to discovery
                <Icon name="chevron-right" size={14} />
              </button>
              <span className="muted small">Discovery takes 10–60 seconds and counts what's in your Workspace.</span>
            </div>
          )}
        </div>
      </div>
    </>
  )
}
