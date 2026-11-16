// Settings → API keys → Personal Tokens: the tokens a person's own server uses to send email as them. A token is
// shown once, right after it is created. Everyone sees their own; owners and admins also see everyone's, can revoke
// any of them and can turn tokens off for the whole organization.

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { Icon } from '../components/Icon'
import { toast } from '../components/Toast'
import { api, copyText, errorMessage, SITE_URL } from '../lib/core'
import { ConfirmDialog, Modal } from '../storage/dialogs'
import '../styles/storage.css'
import '../styles/users.css'

type TokenState = 'active' | 'inactive' | 'expired' | 'revoked'

type Token = {
  id: string
  name: string
  masked: string
  scopes: string[]
  mailboxes: { id: string; address: string; usable: boolean }[]
  state: TokenState
  person: { userId: string; name: string | null; email: string; you: boolean }
  createdAt: string
  lastUsedAt: string | null
  expiresAt: string | null
}

type TokenList = {
  tokens: Token[]
  enabled: boolean
  canManage: boolean
  mailboxes: { id: string; address: string; kind: string }[]
  limit: number
}

type ExpiresIn = '30d' | '90d' | '1y' | 'never'

const keys = { list: (orgId: string) => ['tokens', orgId] as const }
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })

function activity(t: Token): string {
  const parts = [`Created ${day(t.createdAt)}`, t.lastUsedAt ? `last used ${day(t.lastUsedAt)}` : 'never used']
  if (t.expiresAt) parts.push(`${t.state === 'expired' ? 'ended' : 'ends'} ${day(t.expiresAt)}`)
  return parts.join(' · ')
}

const STATE_NOTE: Partial<Record<TokenState, { tag: string; title: string }>> = {
  inactive: { tag: 'Inactive', title: 'Its owner can no longer send from any of its mailboxes. It works again if access comes back.' },
  expired: { tag: 'Expired', title: 'It has ended and can no longer be used.' },
}

export function PersonalTokens({ orgId, admin }: { orgId: string; admin: boolean }) {
  const client = useQueryClient()
  const query = useQuery({ queryKey: keys.list(orgId), queryFn: () => api<TokenList>('GET', `/orgs/${orgId}/tokens${admin ? '?all=true' : ''}`) })
  const [creating, setCreating] = useState(false)
  const [created, setCreated] = useState<{ name: string; secret: string } | null>(null)
  const [editing, setEditing] = useState<Token | null>(null)
  const [revoking, setRevoking] = useState<Token | null>(null)
  const [switching, setSwitching] = useState(false)
  const refresh = () => client.invalidateQueries({ queryKey: keys.list(orgId) })

  if (query.error) return <p className="form-error">{errorMessage(query.error)}</p>
  if (!query.data) return <div className="loading"><span className="spinner" /></div>
  const { tokens, enabled, mailboxes, limit } = query.data
  const yours = tokens.filter((t) => t.person.you)
  const others = tokens.filter((t) => !t.person.you)
  const full = yours.filter((t) => t.state !== 'expired').length >= limit
  const blocked = !enabled ? 'API tokens are turned off for this organization' : !mailboxes.length ? 'You have no mailbox you can send from' : full ? `You can have ${limit} tokens` : null

  const setEnabled = async (on: boolean) => {
    setSwitching(true)
    try {
      await api('PUT', `/orgs/${orgId}/tokens/settings`, { enabled: on })
      await refresh()
      toast(on ? 'API tokens turned on' : 'API tokens turned off')
    } catch (err) {
      toast(errorMessage(err))
    }
    setSwitching(false)
  }

  const row = (t: Token) => {
    const note = STATE_NOTE[t.state]
    return (
      <div key={t.id} className="card-row">
        <span className="lead"><Icon name="key-round" size={15} /></span>
        <div className="text">
          <span className="name">
            {t.name} <span className="dim small mono">{t.masked}</span>
            {note && <span className="tag" title={note.title}>{note.tag}</span>}
          </span>
          {!t.person.you && <span className="sub">{t.person.name ? `${t.person.name} · ${t.person.email}` : t.person.email}</span>}
          <span className="sub ellipsis" title={t.mailboxes.map((m) => m.address).join(', ')}>
            {t.mailboxes.length ? `Sends from ${t.mailboxes.map((m) => (m.usable ? m.address : `${m.address} (no access)`)).join(', ')}` : 'No mailboxes'}
          </span>
          <span className="sub dim">{activity(t)}</span>
        </div>
        <span className="right row-gap">
          {t.person.you && t.state !== 'expired' && <button className="btn" onClick={() => setEditing(t)}>Edit</button>}
          <button className="btn" onClick={() => setRevoking(t)}>Revoke</button>
        </span>
      </div>
    )
  }

  return (
    <>
      <div className="group">
        <div className="group-head">
          <div className="text">
            <h2>Personal tokens</h2>
            <p>
              A token lets your own server send email from mailboxes you can send from, as you. Send it as{' '}
              <code>Authorization: Bearer</code> to <code>POST /v1/emails</code>. A token is shown once when you create it, and it stops
              working if you lose access to its mailboxes or leave the organization.{' '}
              <a className="hi" href={`${SITE_URL}/docs/transactional-email`} target="_blank" rel="noreferrer">Read the docs</a>
            </p>
          </div>
          <button className="btn btn-primary" disabled={!!blocked} title={blocked ?? undefined} onClick={() => setCreating(true)}>
            Create token
          </button>
        </div>
        {!enabled && (
          <div className="tok-notice">
            <Icon name="info" size={14} />
            <div>
              API tokens are turned off for this organization. Existing tokens are refused until {admin ? 'you turn them' : 'an owner or admin turns them'} back on.
            </div>
          </div>
        )}
        <div className="card">
          {yours.length ? yours.map(row) : (
            <div className="card-row"><div className="text"><span className="sub">You haven't created any tokens in this organization.</span></div></div>
          )}
        </div>
      </div>
      {admin && (
        <div className="group">
          <div className="group-head">
            <div className="text">
              <h2>All members</h2>
              <p>Tokens other people in the organization created. Revoking one ends it at once; its owner can create a new one.</p>
            </div>
          </div>
          <div className="card">
            {others.length ? others.map(row) : (
              <div className="card-row"><div className="text"><span className="sub">No one else has created a token.</span></div></div>
            )}
          </div>
          <div className="card solo">
            <div className="card-row">
              <div className="text">
                <span className="name">Allow personal tokens</span>
                <span className="sub">Turn off to refuse every member's tokens at once. Nothing is deleted: they work again when you turn this back on.</span>
              </div>
              <button
                className="switch"
                role="switch"
                aria-checked={enabled}
                aria-label="Allow personal tokens"
                disabled={switching}
                onClick={() => void setEnabled(!enabled)}
              />
            </div>
          </div>
        </div>
      )}
      {creating && (
        <TokenDialog
          orgId={orgId}
          mailboxes={mailboxes}
          onClose={() => setCreating(false)}
          onSaved={(secret, name) => {
            void refresh()
            if (secret) setCreated({ name, secret })
          }}
        />
      )}
      {editing && (
        <TokenDialog
          orgId={orgId}
          token={editing}
          mailboxes={mailboxes}
          onClose={() => setEditing(null)}
          onSaved={() => {
            void refresh()
            toast('Token saved')
          }}
        />
      )}
      {created && <CreatedDialog name={created.name} secret={created.secret} onClose={() => setCreated(null)} />}
      {revoking && (
        <ConfirmDialog
          title={`Revoke ${revoking.name}`}
          body={
            revoking.person.you
              ? 'This token stops working at once, and anything that sends email with it will be refused. It can’t be brought back.'
              : `${revoking.person.name ?? revoking.person.email}'s token stops working at once, and anything that sends email with it will be refused. It can’t be brought back.`
          }
          action="Revoke"
          onClose={() => setRevoking(null)}
          onConfirm={async () => {
            try {
              await api('DELETE', `/orgs/${orgId}/tokens/${encodeURIComponent(revoking.id)}`)
              void refresh()
              toast('Token revoked')
            } catch (err) {
              toast(errorMessage(err))
            }
          }}
        />
      )}
    </>
  )
}

/** Creates a token, or with `token` renames it and changes its mailboxes. */
function TokenDialog({
  orgId,
  token,
  mailboxes,
  onClose,
  onSaved,
}: {
  orgId: string
  token?: Token
  mailboxes: TokenList['mailboxes']
  onClose: () => void
  onSaved: (secret: string | null, name: string) => void
}) {
  const [name, setName] = useState(token?.name ?? '')
  // A mailbox the person lost access to can't be kept: saving drops it.
  const [picked, setPicked] = useState<string[]>(() =>
    token ? token.mailboxes.filter((m) => m.usable).map((m) => m.id) : mailboxes.length === 1 ? [mailboxes[0]!.id] : [],
  )
  const [expiresIn, setExpiresIn] = useState<ExpiresIn>('never')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const toggle = (id: string) => setPicked(picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id])

  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (!name.trim()) return setError('Give the token a name.')
    if (!picked.length) return setError('Choose at least one mailbox.')
    setBusy(true)
    setError('')
    try {
      if (token) {
        await api('PATCH', `/orgs/${orgId}/tokens/${encodeURIComponent(token.id)}`, { name: name.trim(), mailboxIds: picked })
        onSaved(null, name.trim())
      } else {
        const r = await api<{ secret: string }>('POST', `/orgs/${orgId}/tokens`, { name: name.trim(), mailboxIds: picked, expiresIn })
        onSaved(r.secret, name.trim())
      }
      onClose()
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  return (
    <Modal title={token ? `Edit ${token.name}` : 'Create token'} onClose={onClose}>
      <form onSubmit={(e) => void save(e)} noValidate>
        <div className="modal-body tok-form">
          <label className="field">
            Name
            <input className="text-input" autoFocus maxLength={80} placeholder="Billing server" value={name} onChange={(e) => setName(e.target.value)} />
            <span className="dim small">Where the token will be used, so you can tell your tokens apart.</span>
          </label>
          <div className="field">
            Mailboxes it can send from
            <div className="tok-boxes">
              {mailboxes.map((m) => (
                <label key={m.id} className="tok-box">
                  <input type="checkbox" checked={picked.includes(m.id)} onChange={() => toggle(m.id)} />
                  <span className="ellipsis">{m.address}</span>
                  <span className="dim small">{m.kind}</span>
                </label>
              ))}
            </div>
          </div>
          {!token && (
            <label className="field">
              Ends
              <select className="select" value={expiresIn} onChange={(e) => setExpiresIn(e.target.value as ExpiresIn)}>
                <option value="never">Never</option>
                <option value="30d">In 30 days</option>
                <option value="90d">In 90 days</option>
                <option value="1y">In 1 year</option>
              </select>
              <span className="dim small">You get an email a week before a token ends.</span>
            </label>
          )}
        </div>
        <div className="modal-foot">
          <span className="err" role="alert">{error}</span>
          <span className="row-gap">
            <button type="button" className="btn btn-quiet" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" disabled={busy}>{busy && <span className="spinner" />}{token ? 'Save' : 'Create token'}</button>
          </span>
        </div>
      </form>
    </Modal>
  )
}

/** The only time the token is shown. */
function CreatedDialog({ name, secret, onClose }: { name: string; secret: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    const ok = await copyText(secret)
    setCopied(ok)
    toast(ok ? 'Copied' : "Couldn't copy")
  }
  return (
    <Modal title={`Token created: ${name}`} onClose={onClose}>
      <div className="modal-body tok-form">
        <p className="muted">Copy the token now and keep it somewhere safe, such as your server's secrets. It won't be shown again.</p>
        <div className="key-line tok-secret">
          <input className="text-input" readOnly value={secret} aria-label="Token" onFocus={(e) => e.target.select()} />
          <button className="btn" onClick={() => void copy()}><Icon name="copy" size={13} />Copy</button>
        </div>
      </div>
      <div className="modal-foot">
        <span />
        <button className="btn btn-primary" onClick={onClose}>{copied ? 'Done' : 'I’ve copied it'}</button>
      </div>
    </Modal>
  )
}
