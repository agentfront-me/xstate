// Settings → Access → App passwords: the passwords mail and calendar apps sign in with, since they can't do the web
// sign-in. One is shown once, right after it is created. Everyone sees their own; owners and admins also see
// everyone's, can revoke any of them and can turn mail apps off for the whole organization.

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { Icon } from '../components/Icon'
import { toast } from '../components/Toast'
import { api, copyText, errorMessage } from '../lib/core'
import { ConfirmDialog, Modal } from '../storage/dialogs'
import '../styles/storage.css'
import '../styles/users.css'

type AppPassword = {
  id: string
  name: string
  person: { userId: string; name: string | null; email: string; you: boolean }
  createdAt: string
  lastUsedAt: string | null
}

type AppPasswordList = {
  /** False until mail apps are released to this organization: the tab stays hidden. */
  available: boolean
  passwords: AppPassword[]
  enabled: boolean
  canManage: boolean
  max: number
  server: { host: string; imapPort: number; smtpPort: number }
}

const keys = { list: (orgId: string) => ['app-passwords', orgId] as const }
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
const load = (orgId: string, all: boolean) => api<AppPasswordList>('GET', `/orgs/${orgId}/app-passwords${all ? '?all=true' : ''}`)

/** Whether to show the App passwords tab at all. Asked only while the Access page is open. */
export function useMailAppsAvailable(orgId: string, enabled: boolean): boolean {
  return useQuery({ queryKey: [...keys.list(orgId), 'available'], queryFn: () => load(orgId, false), enabled, staleTime: 5 * 60_000 }).data?.available ?? false
}

export function AppPasswords({ orgId, admin }: { orgId: string; admin: boolean }) {
  const client = useQueryClient()
  const query = useQuery({ queryKey: keys.list(orgId), queryFn: () => load(orgId, admin) })
  const [creating, setCreating] = useState(false)
  const [created, setCreated] = useState<{ name: string; secret: string } | null>(null)
  const [revoking, setRevoking] = useState<AppPassword | null>(null)
  const [switching, setSwitching] = useState(false)
  const refresh = () => client.invalidateQueries({ queryKey: keys.list(orgId) })

  if (query.error) return <p className="form-error">{errorMessage(query.error)}</p>
  if (!query.data) return <div className="loading"><span className="spinner" /></div>
  const { passwords, enabled, max, server } = query.data
  const yours = passwords.filter((p) => p.person.you)
  const others = passwords.filter((p) => !p.person.you)
  const blocked = !enabled ? 'Mail apps are turned off for this organization' : yours.length >= max ? `You can have ${max} app passwords` : null

  const setEnabled = async (on: boolean) => {
    setSwitching(true)
    try {
      await api('PUT', `/orgs/${orgId}/app-passwords/settings`, { enabled: on })
      await refresh()
      toast(on ? 'Mail apps turned on' : 'Mail apps turned off')
    } catch (err) {
      toast(errorMessage(err))
    }
    setSwitching(false)
  }

  const row = (p: AppPassword) => (
    <div key={p.id} className="card-row">
      <span className="lead"><Icon name="key-round" size={15} /></span>
      <div className="text">
        <span className="name">{p.name}</span>
        {!p.person.you && <span className="sub">{p.person.name ? `${p.person.name} · ${p.person.email}` : p.person.email}</span>}
        <span className="sub dim">Created {day(p.createdAt)} · {p.lastUsedAt ? `last used ${day(p.lastUsedAt)}` : 'never used'}</span>
      </div>
      <span className="right row-gap">
        <button className="btn" onClick={() => setRevoking(p)}>Revoke</button>
      </span>
    </div>
  )

  return (
    <>
      <div className="group">
        <div className="group-head">
          <div className="text">
            <h2>App passwords</h2>
            <p>
              An app password lets a mail app such as Apple Mail, Outlook or Thunderbird read and send your mail. In the app, use{' '}
              <code>{server.host}</code> as the incoming and outgoing server, your mailbox's address as the username, and the app
              password as the password. It works for every mailbox you can open, and stops working if you leave the organization.
            </p>
          </div>
          <button className="btn btn-primary" disabled={!!blocked} title={blocked ?? undefined} onClick={() => setCreating(true)}>
            Create app password
          </button>
        </div>
        {!enabled && (
          <div className="tok-notice">
            <Icon name="info" size={14} />
            <div>
              Mail apps are turned off for this organization. Every app password is refused until {admin ? 'you turn them' : 'an owner or admin turns them'} back on.
            </div>
          </div>
        )}
        <div className="card">
          {yours.length ? yours.map(row) : (
            <div className="card-row"><div className="text"><span className="sub">You haven't created any app passwords in this organization.</span></div></div>
          )}
        </div>
        <div className="card solo">
          <div className="card-row">
            <div className="text">
              <span className="name">Server settings</span>
              <span className="sub">Incoming mail (IMAP): <span className="mono">{server.host}</span>, port {server.imapPort}, SSL/TLS</span>
              <span className="sub">Outgoing mail (SMTP): <span className="mono">{server.host}</span>, port {server.smtpPort}, SSL/TLS</span>
              <span className="sub">Username: the mailbox's full address. Password: an app password.</span>
            </div>
          </div>
        </div>
      </div>
      {admin && (
        <div className="group">
          <div className="group-head">
            <div className="text">
              <h2>All members</h2>
              <p>App passwords other people in the organization created. Revoking one signs that app out; its owner can create a new one.</p>
            </div>
          </div>
          <div className="card">
            {others.length ? others.map(row) : (
              <div className="card-row"><div className="text"><span className="sub">No one else has created an app password.</span></div></div>
            )}
          </div>
          <div className="card solo">
            <div className="card-row">
              <div className="text">
                <span className="name">Allow mail and calendar apps</span>
                <span className="sub">
                  Turn off to refuse every member's app passwords at once. Nothing is deleted: they work again when you turn this back on.
                  Some mail apps keep a copy of the mail on their maker's servers; turn this off if your organization doesn't allow that.
                </span>
              </div>
              <button
                className="switch"
                role="switch"
                aria-checked={enabled}
                aria-label="Allow mail and calendar apps"
                disabled={switching}
                onClick={() => void setEnabled(!enabled)}
              />
            </div>
          </div>
        </div>
      )}
      {creating && (
        <CreateDialog
          orgId={orgId}
          onClose={() => setCreating(false)}
          onCreated={(secret, name) => {
            void refresh()
            setCreated({ name, secret })
          }}
        />
      )}
      {created && <CreatedDialog name={created.name} secret={created.secret} host={server.host} onClose={() => setCreated(null)} />}
      {revoking && (
        <ConfirmDialog
          title={`Revoke ${revoking.name}`}
          body={
            revoking.person.you
              ? 'The app using this password is refused the next time it signs in. It can’t be brought back.'
              : `The app using ${revoking.person.name ?? revoking.person.email}'s password is refused the next time it signs in. It can’t be brought back.`
          }
          action="Revoke"
          onClose={() => setRevoking(null)}
          onConfirm={async () => {
            try {
              await api('DELETE', `/orgs/${orgId}/app-passwords/${encodeURIComponent(revoking.id)}`)
              void refresh()
              toast('App password revoked')
            } catch (err) {
              toast(errorMessage(err))
            }
          }}
        />
      )}
    </>
  )
}

function CreateDialog({ orgId, onClose, onCreated }: { orgId: string; onClose: () => void; onCreated: (secret: string, name: string) => void }) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const save = async (e: FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return setError('Give the app password a name')
    setBusy(true)
    setError('')
    try {
      const r = await api<{ secret: string }>('POST', `/orgs/${orgId}/app-passwords`, { name: name.trim() })
      onCreated(r.secret, name.trim())
      onClose()
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }
  return (
    <Modal title="Create app password" onClose={onClose}>
      <form onSubmit={(e) => void save(e)} noValidate>
        <div className="modal-body tok-form">
          <label className="field">
            Name
            <input className="text-input" autoFocus maxLength={80} placeholder="iPhone Mail" value={name} onChange={(e) => setName(e.target.value)} />
            <span className="dim small">The app or device it's for, so you can tell your app passwords apart. Use one per app.</span>
          </label>
        </div>
        <div className="modal-foot">
          <span className="err" role="alert">{error}</span>
          <span className="row-gap">
            <button type="button" className="btn btn-quiet" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" disabled={busy}>{busy && <span className="spinner" />}Create app password</button>
          </span>
        </div>
      </form>
    </Modal>
  )
}

/** The only time the app password is shown. */
function CreatedDialog({ name, secret, host, onClose }: { name: string; secret: string; host: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    const ok = await copyText(secret)
    setCopied(ok)
    toast(ok ? 'Copied' : "Couldn't copy")
  }
  return (
    <Modal title={`App password created: ${name}`} onClose={onClose}>
      <div className="modal-body tok-form">
        <p className="muted">
          Type or paste this into your mail app as the password, with <span className="mono">{host}</span> as the server and your mailbox's
          address as the username. It won't be shown again.
        </p>
        <div className="key-line tok-secret">
          <input className="text-input mono" readOnly value={secret} aria-label="App password" onFocus={(e) => e.target.select()} />
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
