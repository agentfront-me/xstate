// Settings: Account, Members, Domains, Secrets, API keys, Billing, Integrations.
//
// Account, Domains and API keys use the API when signed in. Members, Secrets, Billing and Integrations have no API yet:
// they show sample data (./store), marked "Sample data" in the header when signed in, and changes stay in memory.

import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Icon, type IconName } from '../components/Icon'
import { toast } from '../components/Toast'
import { addDomain, isDemo, mailboxesOf, removeDomain, useAccount, verifyDomain, type Account } from '../lib/account'
import {
  applyTheme,
  copyText,
  desktop,
  DOMAIN_RE,
  errorMessage,
  initials,
  isEmail,
  signOut,
  themeChoice,
  type DesktopSettings,
  type ThemeChoice,
} from '../lib/core'
import type { Member } from '../lib/sample'
import type { Domain } from '../lib/types'
import { ConfirmDialog } from '../storage/dialogs'
import { type ApiKeys, keysApi } from '../users/api'
import { CodeBlock, snippetFor } from '../users/UsersPage'
import { setSettings, useSettingsData, type SettingsData } from './store'

type Section = {
  id: 'account' | 'members' | 'domains' | 'secrets' | 'api-keys' | 'billing' | 'integrations'
  label: string
  icon: IconName
  sample?: boolean
  sub: (a: Account, d: SettingsData) => string
}

const SECTIONS: Section[] = [
  { id: 'account', label: 'Account', icon: 'user', sub: () => 'Profile, appearance, desktop app' },
  {
    id: 'members',
    label: 'Members',
    icon: 'users',
    sub: (_a, d) => {
      const invited = d.members.filter((m) => m.invited).length
      const n = 1 + d.members.length - invited
      return `${n} ${n === 1 ? 'member' : 'members'}${invited ? ` · ${invited} invited` : ''}`
    },
  },
  {
    id: 'domains',
    label: 'Domains',
    icon: 'at-sign',
    sub: (a) => {
      const n = a.domains.length
      if (!n) return 'No domains yet'
      return `${a.domains.filter((d) => d.status === 'verified').length} of ${n} verified`
    },
  },
  { id: 'secrets', label: 'Secrets', icon: 'key-round', sample: true, sub: (_a, d) => `${d.secrets.length} organization secrets` },
  { id: 'api-keys', label: 'API keys', icon: 'code', sub: () => 'Publishable and secret key' },
  { id: 'billing', label: 'Billing', icon: 'credit-card', sample: true, sub: (_a, d) => `${d.billing.plan} · renews ${d.billing.renewsShort}` },
  {
    id: 'integrations',
    label: 'Integrations',
    icon: 'blocks',
    sample: true,
    sub: (_a, d) => `${d.integrations.filter((i) => i.connected).length} connected`,
  },
]

export function SettingsPage({ section }: { section: string }) {
  const account = useAccount()
  const data = useSettingsData()
  const navigate = useNavigate()
  const s = SECTIONS.find((x) => x.id === section) ?? SECTIONS[0]!

  return (
    <section className="settings">
      <nav className="settings-nav" aria-label="Settings">
        <div className="col-head drag">
          <span className="title">Settings</span>
        </div>
        <div className="items">
          {SECTIONS.map((x) => (
            <button
              key={x.id}
              className="set-item"
              aria-current={x.id === s.id ? 'page' : undefined}
              onClick={() => void navigate({ to: '/settings/$section', params: { section: x.id } })}
            >
              <span className="tile">
                <Icon name={x.icon} size={14} />
              </span>
              <span className="text">
                <span className="name">{x.label}</span>
                <span className="sub ellipsis">{x.sub(account, data)}</span>
              </span>
            </button>
          ))}
        </div>
      </nav>
      <div className="settings-main">
        <div className="settings-head drag">
          <div className="title">
            {s.label}
            {s.sample && !isDemo() && (
              <span className="tag" title="This section has no API yet">
                Sample data
              </span>
            )}
          </div>
          <div className="sub">{s.sub(account, data)}</div>
        </div>
        <div className="settings-scroll">
          <div className="settings-body">
            {s.id === 'account' && <AccountSection account={account} />}
            {s.id === 'members' && <MembersSection account={account} data={data} />}
            {s.id === 'domains' && <DomainsSection account={account} />}
            {s.id === 'secrets' && <SecretsSection data={data} />}
            {s.id === 'api-keys' && <ApiKeysSection account={account} />}
            {s.id === 'billing' && <BillingSection data={data} />}
            {s.id === 'integrations' && <IntegrationsSection data={data} />}
          </div>
        </div>
      </div>
    </section>
  )
}

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

const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1)

// ---------------------------------------------------------------------------------------------------------------
// Account

const DESKTOP_TOGGLES = [
  { key: 'launchAtLogin', name: 'Launch at login', sub: 'Open xstate in the background when you sign in.' },
  { key: 'notifications', name: 'Desktop notifications', sub: 'New mail, escalations and agent handoffs.' },
  { key: 'menuBar', name: 'Show in menu bar', sub: 'Keep unread count visible when the window is closed.' },
  { key: 'autoUpdate', name: 'Install updates automatically', sub: 'Updates download in the background and apply on restart.' },
]

const THEMES: [ThemeChoice, string, IconName][] = [
  ['light', 'Light', 'sun'],
  ['dark', 'Dark', 'moon'],
  ['system', 'System', 'monitor'],
]

function AccountSection({ account }: { account: Account }) {
  const [theme, setTheme] = useState(themeChoice)
  const demo = isDemo()

  return (
    <>
      <div className="group">
        <GroupHead title="Profile" />
        <div className="fields">
          <label className="field">
            Name
            <input className="text-input" value={account.user.name ?? ''} readOnly title="Name changes are coming soon" />
          </label>
          <label className="field">
            Email
            <input className="text-input" value={account.user.email} readOnly />
          </label>
        </div>
      </div>
      <div className="group">
        <GroupHead title="Appearance" />
        <div className="choices" role="group" aria-label="Appearance">
          {THEMES.map(([id, label, ic]) => (
            <button
              key={id}
              className="choice"
              aria-pressed={theme === id}
              onClick={() => {
                applyTheme(id)
                setTheme(id)
              }}
            >
              <Icon name={ic} size={15} />
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="group" id="desktop">
        <GroupHead title="Desktop app" />
        {desktop ? (
          <DesktopSettingsCard />
        ) : (
          <div className="card solo">
            <div className="card-row">
              <Icon name="monitor" size={16} />
              <div className="text">
                <span className="name">xstate for desktop</span>
                <span className="sub">Launch at login, desktop notifications and the menu bar count live in the desktop app.</span>
              </div>
            </div>
          </div>
        )}
      </div>
      <div className="card solo">
        <div className="card-row">
          <div className="text">
            <span className="name">Sign out</span>
            <span className="sub">
              {demo
                ? 'You are looking at the demo. Sign in to see your own account.'
                : `Signed in as ${account.user.email}${desktop ? ' on this computer' : ''}.`}
            </span>
          </div>
          <button className="btn" onClick={() => (demo ? location.assign('/login') : signOut())}>
            {demo ? 'Sign in' : 'Sign out'}
          </button>
        </div>
      </div>
    </>
  )
}

function DesktopSettingsCard() {
  const app = desktop!
  const [settings, setSettingsState] = useState<DesktopSettings>({})
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    let live = true
    void app.getSettings().then((s) => live && setSettingsState(s))
    return () => {
      live = false
    }
  }, [app])

  const flip = async (key: string) => {
    const on = !settings[key]
    setSettingsState((s) => ({ ...s, [key]: on }))
    try {
      await app.setSetting(key, on)
    } catch (err) {
      setSettingsState((s) => ({ ...s, [key]: !on }))
      toast(err instanceof Error ? err.message : "Couldn't change that setting")
    }
  }

  const checkUpdates = async () => {
    setChecking(true)
    try {
      toast(await app.checkForUpdates())
    } catch (err) {
      toast(err instanceof Error ? err.message : "Couldn't check for updates")
    } finally {
      setChecking(false)
    }
  }

  return (
    <>
      <div className="card">
        {DESKTOP_TOGGLES.map((t) => (
          <div className="card-row" key={t.key}>
            <div className="text">
              <span className="name">{t.name}</span>
              <span className="sub">{t.sub}</span>
            </div>
            <button className="switch" role="switch" aria-checked={!!settings[t.key]} aria-label={t.name} onClick={() => void flip(t.key)} />
          </div>
        ))}
      </div>
      <div className="foot-line">
        <span id="version">
          xstate for {app.platformName} · Version {app.version}
        </span>
        <button className="btn" disabled={checking} aria-busy={checking} onClick={() => void checkUpdates()}>
          <Icon name="refresh-cw" size={14} />
          Check for updates
        </button>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Members

function MembersSection({ account, data }: { account: Account; data: SettingsData }) {
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<Member['role']>('member')
  const [error, setError] = useState('')
  const me: Member = { id: 'me', name: account.user.name, email: account.user.email, role: 'owner', seen: 'Active now' }
  const rows = [me, ...data.members]

  const invite = (event: FormEvent) => {
    event.preventDefault()
    const value = email.trim().toLowerCase()
    if (!isEmail(value)) return setError('Enter a valid email address.')
    if (!isDemo()) return setError('Inviting teammates is coming soon.')
    if (rows.some((m) => m.email === value)) return setError(`${value} is already on the team.`)
    setError('')
    setEmail('')
    setSettings((d) => ({ ...d, members: [...d.members, { id: `mem_${Date.now()}`, name: null, email: value, role, invited: true }] }))
    toast(`Invite sent to ${value}`)
  }

  const changeRole = (id: string, next: Member['role']) => {
    setSettings((d) => ({ ...d, members: d.members.map((m) => (m.id === id ? { ...m, role: next } : m)) }))
    toast('Role updated')
  }

  const remove = (m: Member) => {
    if (!confirm(`Remove ${m.name || m.email} from ${account.org.name ?? 'the organization'}?`)) return
    setSettings((d) => ({ ...d, members: d.members.filter((x) => x.id !== m.id) }))
  }

  return (
    <>
      <div className="group">
        <GroupHead title="Invite" sub="Members can use the shared inbox, agents and databases. Admins can also manage billing and secrets." />
        <form className="inline-form" noValidate onSubmit={invite}>
          <input
            className="text-input"
            type="email"
            placeholder="name@company.com"
            aria-label="Email to invite"
            autoComplete="off"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <select className="select" aria-label="Role" value={role} onChange={(e) => setRole(e.target.value as Member['role'])}>
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </select>
          <button className="btn btn-primary" style={{ height: 34 }}>
            Send invite
          </button>
        </form>
        <div className="form-error" role="alert">
          {error}
        </div>
      </div>
      <div className="group">
        <GroupHead title="Members" />
        <div className="card">
          {rows.map((m) => (
            <div className="card-row" key={m.id}>
              <span className="avatar md">{m.invited ? m.email[0]!.toUpperCase() : initials(m.name || m.email)}</span>
              <div className="text">
                <span className="name ellipsis">{m.invited ? m.email : m.name || m.email}</span>
                <span className="sub ellipsis">{m.invited ? `Invite pending · ${cap(m.role)}` : `${m.email} · ${m.seen ?? ''}`}</span>
              </div>
              {m.role === 'owner' ? (
                <span className="right">Owner</span>
              ) : (
                <span className="right">
                  <select
                    className="select sm"
                    aria-label={`Role for ${m.name || m.email}`}
                    value={m.role}
                    onChange={(e) => changeRole(m.id, e.target.value as Member['role'])}
                  >
                    <option value="admin">Admin</option>
                    <option value="member">Member</option>
                  </select>
                  <button className="x-btn" aria-label={`Remove ${m.name || m.email}`} onClick={() => remove(m)}>
                    <Icon name="x" size={14} />
                  </button>
                </span>
              )}
            </div>
          ))}
        </div>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Domains

function DomainsSection({ account }: { account: Account }) {
  const client = useQueryClient()
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [adding, setAdding] = useState(false)

  const add = async (event: FormEvent) => {
    event.preventDefault()
    const value = name.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
    if (!DOMAIN_RE.test(value)) return setError('Enter a domain like example.com.')
    if (account.domains.some((d) => d.name === value)) return setError(`${value} is already added.`)
    setAdding(true)
    try {
      await addDomain(client, value)
      toast(`${value} added. Add its DNS records to verify it.`)
      setName('')
      setError('')
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setAdding(false)
    }
  }

  return (
    <div className="group">
      <GroupHead title="Email domains" sub="Agents send and receive mail from mailboxes on verified domains." />
      {account.domains.length ? (
        <div className="card">
          {account.domains.map((d) => (
            <DomainRow key={d.id} account={account} domain={d} />
          ))}
        </div>
      ) : (
        <div className="card solo">
          <div className="card-row">
            <span className="lead">
              <Icon name="at-sign" size={16} />
            </span>
            <div className="text">
              <span className="name">No domains yet</span>
              <span className="sub">Add a domain you own to start receiving mail on it.</span>
            </div>
          </div>
        </div>
      )}
      <form className="inline-form" noValidate onSubmit={(e) => void add(e)}>
        <input
          className="text-input"
          placeholder="example.com"
          aria-label="Domain"
          autoComplete="off"
          spellCheck={false}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button className="btn btn-primary" style={{ height: 34 }} disabled={adding} aria-busy={adding}>
          Add domain
        </button>
      </form>
      <div className="form-error" role="alert">
        {error}
      </div>
    </div>
  )
}

/** Whether mail from this domain can reach outside addresses yet (Amazon SES verification). */
function sendingLabel(d: Domain): string {
  if (d.sending === 'verified') return ' · Sending ready'
  if (d.sending === 'failed') return ' · Sending failed: check the DKIM records'
  if (d.sending === 'pending') return ' · Sending pending: waiting for DKIM records'
  return ''
}

function DomainRow({ account, domain: d }: { account: Account; domain: Domain }) {
  const client = useQueryClient()
  const [checking, setChecking] = useState(false)
  const [removing, setRemoving] = useState(false)
  const n = mailboxesOf(account, d.id).length
  const verified = d.status === 'verified'
  const records = verified ? [] : (account.records[d.id] ?? [])

  const check = async () => {
    setChecking(true)
    try {
      const { domain } = await verifyDomain(client, d.id)
      toast(domain?.status === 'verified' ? 'Verified. Mail is on.' : 'Some records are still missing.')
    } catch (e) {
      toast(errorMessage(e))
    } finally {
      setChecking(false)
    }
  }

  const remove = async () => {
    if (!confirm(`Remove ${d.name}?${n ? ` Its ${n} ${n === 1 ? 'mailbox' : 'mailboxes'} will stop receiving mail.` : ''}`)) return
    setRemoving(true)
    try {
      await removeDomain(client, d.id)
      toast(`${d.name} removed`)
    } catch (e) {
      toast(errorMessage(e))
      setRemoving(false)
    }
  }

  const copy = async (value: string) => toast((await copyText(value)) ? 'Copied' : "Couldn't copy")

  return (
    <>
      <div className="card-row">
        <span className="lead">
          <Icon name="at-sign" size={16} />
        </span>
        <div className="text">
          <span className="name">{d.name}</span>
          <span className="sub">
            {n} {n === 1 ? 'mailbox' : 'mailboxes'}
            {sendingLabel(d)}
          </span>
        </div>
        <span className="right">
          {verified ? (
            <span className="status">
              <Icon name="circle-check" size={14} />
              Verified
            </span>
          ) : (
            <>
              <span className="status pending">
                <Icon name="clock" size={14} />
                Pending DNS
              </span>
              <button className="btn" disabled={checking} aria-busy={checking} onClick={() => void check()}>
                Check DNS
              </button>
            </>
          )}
          <button className="x-btn" aria-label={`Remove ${d.name}`} disabled={removing} aria-busy={removing} onClick={() => void remove()}>
            <Icon name="x" size={14} />
          </button>
        </span>
      </div>
      {records.length > 0 && (
        <div className="records">
          <table>
            <thead>
              <tr>
                <th>Type</th>
                <th>Name</th>
                <th>Value</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {records.map((r, i) => (
                <tr key={i} className={r.found ? 'found' : undefined}>
                  <td>{r.type}</td>
                  <td>{r.name}</td>
                  <td>{r.value}</td>
                  <td>
                    {r.found ? (
                      <Icon name="check" size={13} />
                    ) : (
                      <button aria-label={`Copy ${r.type} value`} onClick={() => void copy(r.value)}>
                        <Icon name="copy" size={13} />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Secrets

function SecretsSection({ data }: { data: SettingsData }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const [error, setError] = useState('')
  const nameRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (open) nameRef.current?.focus()
  }, [open])

  const save = (event: FormEvent) => {
    event.preventDefault()
    const n = name.trim()
    if (!/^[A-Z][A-Z0-9_]*$/.test(n)) return setError('Names use capital letters, digits and underscores.')
    if (!value) return setError('Enter a value.')
    setSettings((d) => ({
      ...d,
      secrets: [
        { name: n, usedBy: '', updated: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) },
        ...d.secrets.filter((s) => s.name !== n),
      ],
    }))
    toast(`${n} saved`)
    setName('')
    setValue('')
    setError('')
    setOpen(false)
  }

  const remove = (n: string) => {
    if (!confirm(`Delete ${n}? Agents that read it will stop working until you add it again.`)) return
    setSettings((d) => ({ ...d, secrets: d.secrets.filter((s) => s.name !== n) }))
  }

  return (
    <div className="group">
      <GroupHead
        title="Organization secrets"
        sub="Encrypted values agents and workflows read as environment variables. Values can't be viewed after saving."
        aside={
          <button className="btn" onClick={() => setOpen(true)}>
            <Icon name="plus" size={14} />
            New secret
          </button>
        }
      />
      <form className="inline-form" hidden={!open} noValidate onSubmit={save}>
        <input
          className="text-input mono"
          placeholder="NAME"
          aria-label="Secret name"
          autoComplete="off"
          spellCheck={false}
          value={name}
          ref={nameRef}
          onChange={(e) => setName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_'))}
        />
        <input
          className="text-input"
          type="password"
          placeholder="Value"
          aria-label="Secret value"
          autoComplete="new-password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <button className="btn btn-primary" style={{ height: 34 }}>
          Save
        </button>
      </form>
      <div className="form-error" role="alert">
        {error}
      </div>
      <div className="card">
        {data.secrets.length ? (
          data.secrets.map((s) => (
            <div className="card-row" key={s.name}>
              <span className="lead">
                <Icon name="key-round" size={15} />
              </span>
              <div className="text">
                <span className="name mono small">{s.name}</span>
                <span className="sub">
                  {s.usedBy || 'Not used yet'} · Updated {s.updated}
                </span>
              </div>
              <span className="right">
                <span aria-label="Hidden value">••••••••</span>
                <button className="x-btn" aria-label={`Delete ${s.name}`} onClick={() => remove(s.name)}>
                  <Icon name="trash" size={14} />
                </button>
              </span>
            </div>
          ))
        ) : (
          <div className="card-row">
            <div className="text">
              <span className="sub">No secrets yet.</span>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------------------------
// API keys: the organization's two keys (design: Settings → API keys). They serve every public API: tracking in the
// Users section today, sending email later.

function ApiKeysSection({ account }: { account: Account }) {
  const admin = account.org.role === 'owner' || account.org.role === 'admin'
  const [keys, setKeys] = useState<ApiKeys | null>(null)
  const [secret, setSecret] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [rolling, setRolling] = useState(false)

  useEffect(() => {
    if (account.mode !== 'live' || !admin) return
    keysApi.get(account.org.id).then((r) => setKeys(r.keys), (err: unknown) => setError(errorMessage(err)))
  }, [account.mode, account.org.id, admin])

  if (account.mode !== 'live') return <p className="muted">Sign in to see your organization's API keys.</p>
  if (!admin) return <p className="muted">Only owners and admins can see the organization's API keys.</p>
  if (error) return <p className="form-error">{error}</p>
  if (!keys) return <div className="loading"><span className="spinner" /></div>

  const copy = async (text: string) => toast((await copyText(text)) ? 'Copied' : "Couldn't copy")
  const reveal = async () => {
    if (secret) return setSecret(null)
    try {
      setSecret((await keysApi.reveal(account.org.id)).key)
    } catch (err) {
      toast(errorMessage(err))
    }
  }
  const copySecret = async () => {
    try {
      await copy(secret ?? (await keysApi.reveal(account.org.id)).key)
    } catch (err) {
      toast(errorMessage(err))
    }
  }
  const lastUsed = keys.secret.lastUsedAt
  const ago = lastUsed ? `Last used ${new Date(lastUsed).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : 'Never used'
  const created = new Date(keys.publishable.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })

  return (
    <>
      <div className="group">
        <GroupHead
          title="API keys"
          sub="Keys for your organization. Use the publishable key in browsers and client apps to identify visitors and track events. Keep the secret key on your servers; it has full access to your organization."
        />
        <div className="card key-card">
          <div className="card-row">
            <div className="key-head">
              <span className="lead"><Icon name="globe" size={15} /></span>
              <div className="text">
                <span className="name">Publishable key</span>
                <span className="sub">Safe to use in browsers and client apps. Identifies visitors and records events.</span>
              </div>
              <span className="when">Created {created}</span>
            </div>
            <div className="key-line">
              <input className="text-input" readOnly value={keys.publishable.key} aria-label="Publishable key" onFocus={(e) => e.target.select()} />
              <button className="btn" onClick={() => void copy(keys.publishable.key)}><Icon name="copy" size={13} />Copy</button>
            </div>
          </div>
          <div className="card-row">
            <div className="key-head">
              <span className="lead"><Icon name="lock" size={15} /></span>
              <div className="text">
                <span className="name">Secret key</span>
                <span className="sub">Server-side only. Full access to users, segments and sending on behalf of your organization.</span>
              </div>
              <span className="when">{ago}</span>
            </div>
            <div className="key-line">
              <input className="text-input" readOnly value={secret ?? keys.secret.masked} aria-label="Secret key" onFocus={(e) => secret && e.target.select()} />
              <button className="btn icon-only" title={secret ? 'Hide' : 'Reveal'} aria-label={secret ? 'Hide secret key' : 'Reveal secret key'} onClick={() => void reveal()}>
                <Icon name={secret ? 'eye-off' : 'eye'} size={14} />
              </button>
              <button className="btn" onClick={() => void copySecret()}><Icon name="copy" size={13} />Copy</button>
              <button className="btn" onClick={() => setRolling(true)}><Icon name="refresh-cw" size={13} />Roll</button>
            </div>
          </div>
        </div>
      </div>
      <div className="group">
        <GroupHead title="Install" sub="Add this to every page of your website. Visitors appear under Users." />
        <CodeBlock code={snippetFor(keys.publishable.key)} />
        <p className="muted small">
          Identify signed-in people with <code>xstate('identify', userId, {'{ email, name }'}, userHash)</code>. Make userHash on your
          server: the hex HMAC-SHA256 of the user id, keyed with the secret key. Server code can call{' '}
          <code>POST /v1/collect</code> with <code>Authorization: Bearer</code> and the secret key instead.
        </p>
      </div>
      {rolling && (
        <ConfirmDialog
          title="Roll secret key"
          body="Make a new secret key? The current one stops working right away, so update your servers with the new key."
          action="Roll key"
          onClose={() => setRolling(false)}
          onConfirm={async () => {
            try {
              const r = await keysApi.roll(account.org.id)
              setKeys(r.keys)
              setSecret(r.key)
              toast('New secret key created')
            } catch (err) {
              toast(errorMessage(err))
            }
          }}
        />
      )}
    </>
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Billing

function BillingSection({ data }: { data: SettingsData }) {
  const b = data.billing
  const used = 1 + data.members.filter((m) => !m.invited).length
  const soon = () => toast('Billing changes are coming soon')

  return (
    <>
      <div className="card solo">
        <div className="card-row">
          <div className="text">
            <span className="name">
              {b.plan} · {b.price}
            </span>
            <span className="sub">
              Renews {b.renews}. {b.seats} seats, {used} of them in use.
            </span>
          </div>
          <button className="btn" onClick={soon}>
            Change plan
          </button>
        </div>
      </div>
      <div className="group">
        <GroupHead title="Usage this period" />
        <div className="card">
          {b.usage.map((u) => (
            <div className="usage" key={u.label}>
              <div className="line">
                <span>{u.label}</span>
                <span>{u.format(u.used, u.total)}</span>
              </div>
              <div className="meter" role="meter" aria-label={u.label} aria-valuenow={u.used} aria-valuemin={0} aria-valuemax={u.total}>
                <span style={{ width: `${Math.min(100, (u.used / u.total) * 100).toFixed(1)}%` }} />
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="group">
        <GroupHead title="Payment method" />
        <div className="card">
          <div className="card-row">
            <span className="lead">
              <Icon name="credit-card" size={16} />
            </span>
            <div className="text">
              <span className="name">
                {b.card.brand} ending in {b.card.last4}
              </span>
              <span className="sub">
                Expires {b.card.expires} · {b.card.email}
              </span>
            </div>
            <button className="btn" onClick={soon}>
              Update
            </button>
          </div>
        </div>
      </div>
      <div className="group">
        <GroupHead title="Invoices" />
        <div className="card">
          {b.invoices.map((i) => (
            <div className="card-row" key={i.date}>
              <div className="text">
                <span className="name">{i.date}</span>
              </div>
              <span className="right">
                Paid{' '}
                <span className="hi" style={{ minWidth: 56, textAlign: 'right' }}>
                  {i.amount}
                </span>
                <button className="x-btn" aria-label={`Download invoice for ${i.date}`} onClick={soon}>
                  <Icon name="download" size={14} />
                </button>
              </span>
            </div>
          ))}
        </div>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Integrations

function IntegrationsSection({ data }: { data: SettingsData }) {
  const toggle = (id: string) => {
    const app = data.integrations.find((i) => i.id === id)
    if (!app) return
    if (app.connected && !confirm(`Disconnect ${app.name}? Agents lose access to it right away.`)) return
    const connected = !app.connected
    setSettings((d) => ({
      ...d,
      integrations: d.integrations.map((i) => (i.id === id ? { ...i, connected, detail: i.detail ?? i.about } : i)),
    }))
    toast(`${app.name} ${connected ? 'connected' : 'disconnected'}`)
  }

  return (
    <div className="group">
      <GroupHead title="Channels and apps" sub="Connected apps are available to every agent as triggers and MCP connectors." />
      <div className="card">
        {data.integrations.map((i) => (
          <div className="card-row" key={i.id}>
            <span className="app-tile" aria-hidden="true">
              {i.glyph}
            </span>
            <div className="text">
              <span className="name">{i.name}</span>
              <span className="sub ellipsis">{i.connected ? `Connected · ${i.detail}` : i.about}</span>
            </div>
            <button className={`btn${i.connected ? '' : ' btn-primary'}`} onClick={() => toggle(i.id)}>
              {i.connected ? 'Disconnect' : 'Connect'}
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
