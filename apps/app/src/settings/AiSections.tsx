// Settings → AI providers and Settings → Secrets (live). Owners and admins only.
// Agents run on the organization's own AI keys: each key is checked before it's saved, shown masked afterwards, and
// its status updates when a run hits a problem with it.

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent, type ReactNode } from 'react'
import { agentKeys, PROVIDER_CONSOLE, PROVIDER_LABEL, providersApi, secretsApi, STATUS_LABEL, type Provider, type ProviderId } from '../agents/api'
import { Icon } from '../components/Icon'
import { toast } from '../components/Toast'
import { isOrgAdmin, type Account } from '../lib/account'
import { ApiError, errorMessage } from '../lib/core'
import { ConfirmDialog, Modal } from '../storage/dialogs'
import '../styles/agents.css'

function GroupHead({ title, sub, aside }: { title: string; sub?: string; aside?: ReactNode }) {
  return (
    <div className="group-head">
      <div className="text">
        <h2>{title}</h2>
        {sub && <p>{sub}</p>}
      </div>
      {aside}
    </div>
  )
}

const date = (iso: string) => new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' })

function Gate({ account, what, children }: { account: Account; what: string; children: ReactNode }) {
  if (account.mode !== 'live') return <p className="muted">Sign in to manage your organization's {what}.</p>
  if (!isOrgAdmin(account.org)) return <p className="muted">Only owners and admins can manage the organization's {what}.</p>
  return <>{children}</>
}

// ---------------------------------------------------------------------------------------------------------------
// AI providers

const PROVIDERS: { id: ProviderId; hint: string; icon: 'sparkles' | 'circle' }[] = [
  { id: 'anthropic', hint: 'Claude', icon: 'sparkles' },
  { id: 'openai', hint: 'GPT', icon: 'circle' },
]

export function AiProvidersSection({ account }: { account: Account }) {
  return (
    <Gate account={account} what="AI providers">
      <AiProviders orgId={account.org.id} />
    </Gate>
  )
}

function AiProviders({ orgId }: { orgId: string }) {
  const client = useQueryClient()
  const query = useQuery({ queryKey: agentKeys.providers(orgId), queryFn: () => providersApi.list(orgId) })
  const [adding, setAdding] = useState<ProviderId | null>(null)
  const [removing, setRemoving] = useState<Provider | null>(null)
  const [checking, setChecking] = useState<ProviderId | null>(null)
  const refresh = () => {
    void client.invalidateQueries({ queryKey: agentKeys.providers(orgId) })
    void client.invalidateQueries({ queryKey: agentKeys.models(orgId) })
  }

  if (query.error) return <p className="form-error">{errorMessage(query.error)}</p>
  if (!query.data) return <div className="loading"><span className="spinner" /></div>
  const byId = new Map(query.data.providers.map((p) => [p.provider, p]))

  const check = async (provider: ProviderId) => {
    setChecking(provider)
    try {
      const { provider: p } = await providersApi.check(orgId, provider)
      toast(p.status === 'valid' ? `${PROVIDER_LABEL[provider]} key works` : (p.statusDetail ?? STATUS_LABEL[p.status]))
      refresh()
    } catch (err) {
      toast(errorMessage(err))
    } finally {
      setChecking(null)
    }
  }

  return (
    <div className="group">
      <GroupHead title="AI providers" sub="Agents run on your own AI account. You're billed by the provider; xstate never marks up usage." />
      <div className="card">
        {PROVIDERS.map(({ id, hint, icon }) => {
          const p = byId.get(id)
          return (
            <div className="card-row ai-provider" key={id}>
              <span className="lead"><Icon name={icon} size={15} /></span>
              <div className="text">
                <span className="name">
                  {PROVIDER_LABEL[id]} <span className="dim small">{hint}</span>
                </span>
                {p ? (
                  <span className="sub">
                    <span className="mono">…{p.last4}</span> · <span className={`key-status ${p.status}`}>{STATUS_LABEL[p.status]}</span>
                    {p.addedBy && ` · Added by ${p.addedBy} · ${date(p.updatedAt)}`}
                    {p.usedBy > 0 && ` · Used by ${p.usedBy} ${p.usedBy === 1 ? 'agent' : 'agents'}`}
                  </span>
                ) : (
                  <span className="sub">Not connected</span>
                )}
                {p && p.status !== 'valid' && p.statusDetail && <span className="sub key-detail">{p.statusDetail}</span>}
                {p && p.models.length > 0 && <span className="sub ellipsis" title={p.models.join(', ')}>{p.models.length} models: {p.models.slice(0, 6).join(', ')}{p.models.length > 6 ? '…' : ''}</span>}
              </div>
              <span className="right row-gap">
                {p ? (
                  <>
                    <button className="btn" disabled={checking === id} onClick={() => void check(id)}>
                      {checking === id ? <span className="spinner" /> : <Icon name="refresh-cw" size={13} />}Check
                    </button>
                    <button className="btn" onClick={() => setAdding(id)}>Replace key</button>
                    <button className="btn btn-quiet" onClick={() => setRemoving(p)}>Remove</button>
                  </>
                ) : (
                  <button className="btn" onClick={() => setAdding(id)}><Icon name="plus" size={13} />Add key</button>
                )}
              </span>
            </div>
          )
        })}
        <div className="card-row">
          <span className="lead"><Icon name="sparkles" size={15} /></span>
          <div className="text">
            <span className="name">Google Gemini</span>
            <span className="sub">Coming soon</span>
          </div>
        </div>
      </div>
      {adding && <AddKeyDialog orgId={orgId} provider={adding} replacing={byId.has(adding)} onClose={() => setAdding(null)} onSaved={refresh} />}
      {removing && (
        <ConfirmDialog
          title={`Remove ${PROVIDER_LABEL[removing.provider]} key`}
          body={
            removing.usedBy
              ? `${removing.usedBy} ${removing.usedBy === 1 ? 'agent uses' : 'agents use'} this key and will stop until you pick another model or add a key again.`
              : 'Agents will no longer be able to use this provider.'
          }
          action="Remove key"
          onClose={() => setRemoving(null)}
          onConfirm={async () => {
            try {
              await providersApi.remove(orgId, removing.provider)
              toast(`${PROVIDER_LABEL[removing.provider]} key removed`)
              refresh()
            } catch (err) {
              toast(errorMessage(err))
            }
          }}
        />
      )}
    </div>
  )
}

function AddKeyDialog({ orgId, provider, replacing, onClose, onSaved }: { orgId: string; provider: ProviderId; replacing: boolean; onClose: () => void; onSaved: () => void }) {
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const name = PROVIDER_LABEL[provider]

  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (!key.trim()) return setError('Paste the key.')
    setBusy(true)
    setError('')
    try {
      const { provider: p } = await providersApi.save(orgId, provider, key.trim())
      toast(`${name} key saved · ${p.models.length} models`)
      onSaved()
      onClose()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : errorMessage(err))
      setBusy(false)
    }
  }

  return (
    <Modal title={`${replacing ? 'Replace' : 'Add'} ${name} key`} onClose={onClose}>
      <form onSubmit={(e) => void save(e)} noValidate>
        <div className="modal-body">
          <input
            className="text-input mono"
            type="password"
            autoFocus
            autoComplete="off"
            spellCheck={false}
            placeholder={provider === 'anthropic' ? 'sk-ant-…' : 'sk-…'}
            aria-label={`${name} API key`}
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
          <p className="muted small">
            Use an API key from{' '}
            <a className="hi" href={PROVIDER_CONSOLE[provider]} target="_blank" rel="noreferrer">
              {provider === 'anthropic' ? 'console.anthropic.com' : 'platform.openai.com'}
            </a>
            .{provider === 'anthropic' && ' A Claude Pro or Max subscription can’t be used here.'} We check it with {name} before saving, and
            only show its last 4 characters afterwards.
          </p>
        </div>
        <div className="modal-foot">
          <span className="err" role="alert">{error}</span>
          <span className="row-gap">
            <button type="button" className="btn btn-quiet" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" disabled={busy}>
              {busy && <span className="spinner" />}
              {busy ? 'Verifying…' : 'Verify and save'}
            </button>
          </span>
        </div>
      </form>
    </Modal>
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Secrets

export function LiveSecretsSection({ account }: { account: Account }) {
  return (
    <Gate account={account} what="secrets">
      <Secrets orgId={account.org.id} />
    </Gate>
  )
}

function Secrets({ orgId }: { orgId: string }) {
  const client = useQueryClient()
  const query = useQuery({ queryKey: agentKeys.secrets(orgId), queryFn: () => secretsApi.list(orgId) })
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [removing, setRemoving] = useState<string | null>(null)

  const save = async (event: FormEvent) => {
    event.preventDefault()
    const n = name.trim()
    if (!/^[A-Z][A-Z0-9_]*$/.test(n)) return setError('Names use capital letters, digits and underscores, and start with a letter.')
    if (!value) return setError('Enter a value.')
    setBusy(true)
    try {
      const { secrets } = await secretsApi.save(orgId, n, value)
      client.setQueryData(agentKeys.secrets(orgId), { secrets })
      toast(`${n} saved`)
      setName('')
      setValue('')
      setError('')
      setOpen(false)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  if (query.error) return <p className="form-error">{errorMessage(query.error)}</p>
  if (!query.data) return <div className="loading"><span className="spinner" /></div>
  const secrets = query.data.secrets

  return (
    <div className="group">
      <GroupHead
        title="Organization secrets"
        sub="Encrypted values used in connector headers, such as an API token. Agents never see the values, and they can't be viewed after saving."
        aside={
          <button className="btn" onClick={() => setOpen(true)}>
            <Icon name="plus" size={14} />
            New secret
          </button>
        }
      />
      <form className="inline-form" hidden={!open} noValidate onSubmit={(e) => void save(e)}>
        <input
          className="text-input mono"
          placeholder="NAME"
          aria-label="Secret name"
          autoComplete="off"
          spellCheck={false}
          value={name}
          onChange={(e) => setName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_'))}
        />
        <input className="text-input" type="password" placeholder="Value" aria-label="Secret value" autoComplete="new-password" value={value} onChange={(e) => setValue(e.target.value)} />
        <button className="btn btn-primary" style={{ height: 34 }} disabled={busy}>Save</button>
      </form>
      <div className="form-error" role="alert">{error}</div>
      <div className="card">
        {secrets.length ? (
          secrets.map((s) => (
            <div className="card-row" key={s.name}>
              <span className="lead"><Icon name="key-round" size={15} /></span>
              <div className="text">
                <span className="name mono small">{s.name}</span>
                <span className="sub">
                  {s.usedBy.length ? `Used by ${s.usedBy.join(', ')}` : 'Not used yet'} · Updated {date(s.updatedAt)}
                  {s.lastUsedAt && ` · Last used ${date(s.lastUsedAt)}`}
                </span>
              </div>
              <span className="right">
                <span aria-label="Hidden value">••••••••</span>
                <button className="x-btn" aria-label={`Replace ${s.name}`} title="Replace value" onClick={() => { setName(s.name); setValue(''); setOpen(true) }}>
                  <Icon name="pencil" size={14} />
                </button>
                <button className="x-btn" aria-label={`Delete ${s.name}`} onClick={() => setRemoving(s.name)}>
                  <Icon name="trash" size={14} />
                </button>
              </span>
            </div>
          ))
        ) : (
          <div className="card-row"><div className="text"><span className="sub">No secrets yet.</span></div></div>
        )}
      </div>
      {removing && (
        <ConfirmDialog
          title={`Delete ${removing}`}
          body="Connectors that use it will stop working until you add it again. This can't be undone."
          action="Delete secret"
          onClose={() => setRemoving(null)}
          onConfirm={async () => {
            try {
              await secretsApi.remove(orgId, removing)
              void client.invalidateQueries({ queryKey: agentKeys.secrets(orgId) })
              toast(`${removing} deleted`)
            } catch (err) {
              toast(errorMessage(err))
            }
          }}
        />
      )}
    </div>
  )
}
