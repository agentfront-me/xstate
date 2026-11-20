// Settings → Apps and API: AI apps (Claude, Cursor, ChatGPT…) connected to the organization over MCP, what each may
// do, and Disconnect. Everyone sees their own; owners and admins see everyone's. Connecting happens in the app
// itself: it sends the person to the consent page (/connect/).

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Icon } from '../components/Icon'
import { toast } from '../components/Toast'
import { isOrgAdmin, type Account } from '../lib/account'
import { api, errorMessage, MCP_URL } from '../lib/core'
import { ConfirmDialog } from '../storage/dialogs'
import { CodeBlock } from '../users/UsersPage'

type Connection = {
  id: string
  app: string
  appDomain: string | null
  person: { userId: string; name: string | null; email: string; you: boolean }
  scopes: string[]
  mailboxes: { id: string; address: string }[]
  connectedAt: string
  lastActiveAt: string | null
  expiresAt: string | null
}

const keys = { list: (orgId: string) => ['connections', orgId] as const }

/** What a connection may do, in the consent page's words. */
export function accessSummary(scopes: string[]): string {
  const has = (s: string) => scopes.includes(s)
  const email = has('mail.send') ? 'draft and send' : has('mail.draft') ? 'draft only' : has('mail.read') ? 'read only' : null
  const parts = email ? [`Email: ${email}`] : []
  for (const [area, label] of [['calendar', 'Calendar'], ['storage', 'Storage'], ['contacts', 'Contacts']] as const) {
    if (has(`${area}.write`)) parts.push(`${label}: read and change`)
    else if (has(`${area}.read`)) parts.push(`${label}: read`)
  }
  if (has('setup')) parts.push('Manages domains and mailboxes')
  return parts.join(' · ')
}

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })

function activity(c: Connection): string {
  if (!c.lastActiveAt) return `Connected ${day(c.connectedAt)}`
  const hours = (Date.now() - Date.parse(c.lastActiveAt)) / 3_600_000
  const last = hours < 2 ? 'within the last hour or two' : hours < 48 ? `${Math.round(hours)} hours ago` : day(c.lastActiveAt)
  return `Connected ${day(c.connectedAt)} · last active ${last}`
}

export function ConnectedAppsSection({ account }: { account: Account }) {
  if (account.mode !== 'live') return <p className="muted">Sign in to see the apps connected to your account.</p>
  return <ConnectedApps orgId={account.org.id} admin={isOrgAdmin(account.org)} />
}

function ConnectedApps({ orgId, admin }: { orgId: string; admin: boolean }) {
  const client = useQueryClient()
  const query = useQuery({ queryKey: keys.list(orgId), queryFn: () => api<{ connections: Connection[] }>('GET', `/orgs/${orgId}/connections`) })
  const [removing, setRemoving] = useState<Connection | null>(null)

  const intro = (
    <div className="group-head">
      <div className="text">
        <h2>Connected apps</h2>
        <p>
          AI apps like Claude, Cursor or ChatGPT that can work with your mail, calendar and files. To connect one, add this address to it as an
          MCP server or connector. You choose what it may do when you approve it.
        </p>
      </div>
    </div>
  )

  if (query.error) return <div className="group">{intro}<p className="form-error">{errorMessage(query.error)}</p></div>
  if (!query.data) return <div className="loading"><span className="spinner" /></div>
  const connections = query.data.connections
  const yours = connections.filter((c) => c.person.you)
  const others = connections.filter((c) => !c.person.you)

  const row = (c: Connection) => (
    <div key={c.id} className="card-row">
      <span className="lead"><Icon name="bot" size={15} /></span>
      <div className="text">
        <span className="name">
          {c.app} <span className="dim small">{c.appDomain ?? 'unverified app'}</span>
        </span>
        {!c.person.you && <span className="sub">{c.person.name ? `${c.person.name} · ${c.person.email}` : c.person.email}</span>}
        <span className="sub">{accessSummary(c.scopes)}</span>
        <span className="sub ellipsis" title={c.mailboxes.map((m) => m.address).join(', ')}>
          {c.mailboxes.length ? c.mailboxes.map((m) => m.address).join(', ') : 'No mailboxes'}
        </span>
        <span className="sub dim">{activity(c)}</span>
      </div>
      <span className="right">
        <button className="btn" onClick={() => setRemoving(c)}>Disconnect</button>
      </span>
    </div>
  )

  return (
    <>
      <div className="group">
        {intro}
        <CodeBlock code={MCP_URL} />
      </div>
      <div className="group">
        <div className="group-head">
          <div className="text">
            <h2>Your apps</h2>
          </div>
        </div>
        <div className="card">
          {yours.length ? yours.map(row) : (
            <div className="card-row"><div className="text"><span className="sub">You haven't connected any apps to this organization.</span></div></div>
          )}
        </div>
      </div>
      {admin && (
        <div className="group">
          <div className="group-head">
            <div className="text">
              <h2>Everyone's apps</h2>
              <p>Apps other people in the organization connected. Disconnecting one ends its access at once; they can connect it again.</p>
            </div>
          </div>
          <div className="card">
            {others.length ? others.map(row) : (
              <div className="card-row"><div className="text"><span className="sub">No one else has connected an app.</span></div></div>
            )}
          </div>
        </div>
      )}
      {removing && (
        <ConfirmDialog
          title={`Disconnect ${removing.app}`}
          body={
            removing.person.you
              ? `${removing.app} loses access to this organization at once. You can connect it again from the app.`
              : `${removing.app} loses access to ${removing.person.name ?? removing.person.email}'s account in this organization at once.`
          }
          action="Disconnect"
          onClose={() => setRemoving(null)}
          onConfirm={async () => {
            try {
              await api('DELETE', `/orgs/${orgId}/connections/${encodeURIComponent(removing.id)}`)
              void client.invalidateQueries({ queryKey: keys.list(orgId) })
              toast(`${removing.app} disconnected`)
            } catch (err) {
              toast(errorMessage(err))
            }
          }}
        />
      )}
    </>
  )
}
