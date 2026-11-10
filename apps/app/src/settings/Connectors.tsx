// Settings → Connectors: MCP servers the organization's agents can use (design: "+ Add connector"). Added by URL,
// signed in with OAuth or sent headers whose values can use Settings → Secrets ({{secret.NAME}}). Owners and admins
// change them; people who manage agents can see them. Each agent then picks which of a connector's tools it may use.

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState, type FormEvent } from 'react'
import { agentKeys, connectorKeys, connectorsApi, secretsApi, type Connector, type ConnectorAuth, type HeaderInput } from '../agents/api'
import { Icon } from '../components/Icon'
import { toast } from '../components/Toast'
import { isOrgAdmin, type Account } from '../lib/account'
import { errorMessage } from '../lib/core'
import { ConfirmDialog, Modal } from '../storage/dialogs'
import '../styles/agents.css'

export const STATUS: Record<Connector['status'], string> = { connected: 'Connected', needs_auth: 'Needs sign-in', error: 'Not reachable' }

const AUTH_LABEL: Record<ConnectorAuth, string> = { none: 'No sign-in', headers: 'Headers', oauth: 'OAuth sign-in' }

/** Opens an OAuth sign-in page. The provider sends the person back to Settings → Connectors. */
export function openSignIn(url: string) {
  const w = window.open(url, '_blank')
  if (w) w.opener = null
  else location.assign(url)
}

export function ConnectorsSection({ account }: { account: Account }) {
  if (account.mode !== 'live') return <p className="muted">Sign in to manage your organization's connectors.</p>
  return <Connectors orgId={account.org.id} admin={isOrgAdmin(account.org)} />
}

function Connectors({ orgId, admin }: { orgId: string; admin: boolean }) {
  const client = useQueryClient()
  const query = useQuery({ queryKey: connectorKeys.list(orgId), queryFn: () => connectorsApi.list(orgId) })
  const [editing, setEditing] = useState<Connector | 'new' | null>(null)
  const [removing, setRemoving] = useState<Connector | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const refresh = () => {
    void client.invalidateQueries({ queryKey: connectorKeys.list(orgId) })
    void client.invalidateQueries({ queryKey: agentKeys.all })
  }

  // Back from an OAuth sign-in: ?connected=<id> or ?error=<message> on the settings URL.
  useEffect(() => {
    const params = new URLSearchParams(location.hash.split('?')[1] ?? '')
    const error = params.get('error')
    if (params.get('connected')) toast('Connected')
    if (error) toast(error)
    if (params.size) history.replaceState(null, '', location.href.split('?')[0])
  }, [])

  const act = async (c: Connector, what: 'refresh' | 'signin') => {
    setBusy(c.id)
    try {
      if (what === 'refresh') {
        const { connector } = await connectorsApi.refresh(orgId, c.id)
        toast(connector.status === 'connected' ? `${connector.tools.length} tools` : (connector.statusDetail ?? STATUS[connector.status]))
      } else {
        const { authUrl } = await connectorsApi.authorize(orgId, c.id)
        if (authUrl) openSignIn(authUrl)
        else toast('Still signed in')
      }
      refresh()
    } catch (err) {
      toast(errorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  if (query.error) return <p className="form-error">{errorMessage(query.error)}</p>
  if (!query.data) return <div className="loading"><span className="spinner" /></div>
  const connectors = query.data.connectors

  return (
    <div className="group">
      <div className="group-head">
        <div className="text">
          <h2>Connectors</h2>
          <p>MCP servers your agents can use, like a shop, a CRM or a ticket system. Each agent picks which of their tools it may call.</p>
        </div>
        {admin && <button className="btn" onClick={() => setEditing('new')}><Icon name="plus" size={14} />Add connector</button>}
      </div>
      <div className="card">
        {connectors.length ? (
          connectors.map((c) => (
            <div key={c.id} className="a-conn">
              <div className="card-row">
                <span className="lead"><Icon name="plug" size={15} /></span>
                <div className="text">
                  <span className="name">
                    {c.name} <span className={`a-conn-status ${c.status}`}>{STATUS[c.status]}</span>
                  </span>
                  <span className="sub ellipsis mono small" title={c.url}>{c.url}</span>
                  <span className="sub">
                    {AUTH_LABEL[c.auth]}
                    {c.headerNames.length > 0 && ` (${c.headerNames.join(', ')})`}
                    {c.secretRefs.length > 0 && ` · uses ${c.secretRefs.join(', ')}`} · {c.tools.length} tools
                    {c.usedBy > 0 && ` · used by ${c.usedBy} ${c.usedBy === 1 ? 'agent' : 'agents'}`}
                  </span>
                  {c.status !== 'connected' && c.statusDetail && <span className="sub a-conn-detail">{c.statusDetail}</span>}
                </div>
                <span className="right row-gap">
                  {c.auth === 'oauth' && admin && (
                    <button className={`btn${c.status === 'needs_auth' ? ' btn-primary' : ''}`} disabled={busy === c.id} onClick={() => void act(c, 'signin')}>
                      {c.status === 'needs_auth' ? 'Sign in' : 'Sign in again'}
                    </button>
                  )}
                  <button className="btn icon-only" title="Check and refresh tools" aria-label="Refresh tools" disabled={busy === c.id} onClick={() => void act(c, 'refresh')}>
                    {busy === c.id ? <span className="spinner" /> : <Icon name="refresh-cw" size={13} />}
                  </button>
                  <button className="btn icon-only" aria-label={open === c.id ? 'Hide tools' : 'Show tools'} onClick={() => setOpen(open === c.id ? null : c.id)}>
                    <Icon name={open === c.id ? 'chevron-down' : 'chevron-right'} size={14} />
                  </button>
                  {admin && <button className="x-btn" aria-label={`Edit ${c.name}`} onClick={() => setEditing(c)}><Icon name="pencil" size={14} /></button>}
                  {admin && <button className="x-btn" aria-label={`Remove ${c.name}`} onClick={() => setRemoving(c)}><Icon name="trash" size={14} /></button>}
                </span>
              </div>
              {open === c.id && (
                <div className="a-conn-tools">
                  {c.tools.length ? (
                    c.tools.map((t) => (
                      <div key={t.name} className="a-conn-tool">
                        <span className="mono small hi">{t.name}</span>
                        <span className="dim small">{t.readOnly ? 'read only' : 'changes things'}</span>
                        <span className="sub small ellipsis" title={t.description}>{t.description}</span>
                      </div>
                    ))
                  ) : (
                    <span className="dim small">No tools found yet.</span>
                  )}
                </div>
              )}
            </div>
          ))
        ) : (
          <div className="card-row"><div className="text"><span className="sub">No connectors yet.{admin ? ' Add one with its MCP URL.' : ' Ask an owner or admin to add one.'}</span></div></div>
        )}
      </div>
      {editing && (
        <ConnectorDialog
          orgId={orgId}
          connector={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
          onSaved={refresh}
        />
      )}
      {removing && (
        <ConfirmDialog
          title={`Remove ${removing.name}`}
          body={removing.usedBy ? `${removing.usedBy} ${removing.usedBy === 1 ? 'agent uses' : 'agents use'} its tools and will lose them.` : 'Agents can no longer use its tools.'}
          action="Remove connector"
          onClose={() => setRemoving(null)}
          onConfirm={async () => {
            try {
              await connectorsApi.remove(orgId, removing.id)
              refresh()
              toast(`${removing.name} removed`)
            } catch (err) {
              toast(errorMessage(err))
            }
          }}
        />
      )}
    </div>
  )
}

/** Add or edit a connector. Exported so an agent's Setup tab can add one in place. */
export function ConnectorDialog({ orgId, connector, onClose, onSaved }: { orgId: string; connector?: Connector; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(connector?.name ?? '')
  const [url, setUrl] = useState(connector?.url ?? '')
  const [auth, setAuth] = useState<ConnectorAuth>(connector?.auth ?? 'oauth')
  // Header values aren't sent back by the API; editing replaces them.
  const [headers, setHeaders] = useState<HeaderInput[]>(connector?.headerNames.map((n) => ({ name: n, value: '' })) ?? [{ name: 'Authorization', value: '' }])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const secrets = useQuery({ queryKey: agentKeys.secrets(orgId), queryFn: () => secretsApi.list(orgId), enabled: auth === 'headers' })

  const save = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    const sendHeaders = auth === 'headers' && (!connector || headers.some((h) => h.value)) ? headers : undefined
    try {
      if (connector) {
        const { connector: c } = await connectorsApi.update(orgId, connector.id, { name, url, headers: sendHeaders })
        toast(c.status === 'connected' ? `Saved · ${c.tools.length} tools` : (c.statusDetail ?? 'Saved'))
      } else {
        const { connector: c, authUrl } = await connectorsApi.create(orgId, { name, url, auth, headers: sendHeaders })
        if (authUrl) {
          toast(`Sign in to ${c.name} in the new window`)
          openSignIn(authUrl)
        } else toast(c.status === 'connected' ? `${c.name} connected · ${c.tools.length} tools` : (c.statusDetail ?? STATUS[c.status]))
      }
      onSaved()
      onClose()
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  const setHeader = (i: number, patch: Partial<HeaderInput>) => setHeaders(headers.map((h, j) => (j === i ? { ...h, ...patch } : h)))

  return (
    <Modal title={connector ? `Edit ${connector.name}` : 'Add connector'} onClose={onClose} wide>
      <form onSubmit={(e) => void save(e)} noValidate>
        <div className="modal-body a-form">
          <div className="a-form-row">
            <label className="field">Name<input className="text-input" autoFocus maxLength={80} placeholder="Shopify" value={name} onChange={(e) => setName(e.target.value)} /></label>
            <label className="field">How it signs in
              <select className="select" value={auth} disabled={!!connector} onChange={(e) => setAuth(e.target.value as ConnectorAuth)}>
                <option value="oauth">OAuth sign-in</option>
                <option value="headers">Headers (an API token)</option>
                <option value="none">No sign-in</option>
              </select>
            </label>
          </div>
          <label className="field">
            MCP server URL
            <input className="text-input mono" placeholder="https://mcp.example.com/mcp" value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false} />
            <span className="dim small">The server's Streamable HTTP endpoint, from its documentation.</span>
          </label>
          {auth === 'oauth' && <p className="muted small">After adding it, a window opens to sign in to the service. xstate keeps the sign-in for the whole organization.</p>}
          {auth === 'headers' && (
            <div className="field">
              Headers
              {headers.map((h, i) => (
                <div key={i} className="a-header-row">
                  <input className="text-input mono" placeholder="Authorization" value={h.name} onChange={(e) => setHeader(i, { name: e.target.value })} />
                  <input
                    className="text-input mono"
                    placeholder={connector ? 'Unchanged (enter to replace)' : 'Bearer {{secret.NAME}}'}
                    value={h.value}
                    onChange={(e) => setHeader(i, { value: e.target.value })}
                  />
                  <select
                    className="select"
                    aria-label="Insert a secret"
                    value=""
                    onChange={(e) => e.target.value && setHeader(i, { value: `${h.value}{{secret.${e.target.value}}}` })}
                  >
                    <option value="">Insert secret…</option>
                    {secrets.data?.secrets.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
                  </select>
                  <button type="button" className="x-btn" aria-label="Remove header" onClick={() => setHeaders(headers.filter((_, j) => j !== i))}><Icon name="x" size={14} /></button>
                </div>
              ))}
              <button type="button" className="a-link" onClick={() => setHeaders([...headers, { name: '', value: '' }])}>Add header</button>
              <span className="dim small">Put tokens in Settings → Secrets and refer to them as {'{{secret.NAME}}'}: they're filled in only when a call is made, and never shown to agents.</span>
            </div>
          )}
        </div>
        <div className="modal-foot">
          <span className="err" role="alert">{error}</span>
          <span className="row-gap">
            <button type="button" className="btn btn-quiet" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" disabled={busy}>{busy && <span className="spinner" />}{connector ? 'Save' : auth === 'oauth' ? 'Add and sign in' : 'Add and connect'}</button>
          </span>
        </div>
      </form>
    </Modal>
  )
}
