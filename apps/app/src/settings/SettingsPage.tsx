// Settings: Account, Members, Domains, Migration, Secrets, API keys, Billing, Integrations.
//
// Account, Members, Domains and API keys use the API when signed in. Secrets, Billing and Integrations have no API
// yet: they show sample data (./store), marked "Sample data" in the header when signed in, and changes stay in memory.
// In demo mode (?demo) every section uses sample data.

import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Icon, type IconName } from '../components/Icon'
import { RecordCell } from '../components/RecordCell'
import { toast } from '../components/Toast'
import { addDomain, createMailbox, isDemo, isOrgAdmin, mailboxesOf, removeDomain, useAccount, verifyDomain, type Account } from '../lib/account'
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
import { accessReminder, summary as migrationSummary, type AccessReminder } from '../migration/api'
import type { Stage as MigrationStage } from '../migration/types'
import type { Domain, MailboxKind } from '../lib/types'
import { ConfirmDialog } from '../storage/dialogs'
import { type ApiKeys, keysApi } from '../users/api'
import { CodeBlock, snippetFor } from '../users/UsersPage'
import { inviteMember, membersSub, removeMember, resendInvite, setMemberRole, useMembers, type OrgMember } from './members'
import { setSettings, useSettingsData, type SettingsData } from './store'

type Section = {
  id: 'account' | 'members' | 'domains' | 'migration' | 'secrets' | 'api-keys' | 'billing' | 'integrations'
  label: string
  icon: IconName
  sample?: boolean
  /** `m`: the organization's members from the API (signed in), undefined while loading or in demo mode. */
  sub: (a: Account, d: SettingsData, m: OrgMember[] | undefined) => string
}

const SECTIONS: Section[] = [
  { id: 'account', label: 'Account', icon: 'user', sub: () => 'Profile, appearance, desktop app' },
  {
    id: 'members',
    label: 'Members',
    icon: 'users',
    sub: (a, d, m) => {
      if (a.mode === 'live') return m ? membersSub(m) : 'Members and invites'
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
  { id: 'migration', label: 'Migration', icon: 'download', sub: (a) => migrationSub(a) },
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
  const members = useMembers(account.org.id, account.mode === 'live').data

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
                <span className="sub ellipsis">{x.sub(account, data, members)}</span>
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
          <div className="sub">{s.sub(account, data, members)}</div>
        </div>
        <div className="settings-scroll">
          <div className="settings-body">
            {s.id === 'account' && <AccountSection account={account} />}
            {s.id === 'members' && (account.mode === 'live' ? <LiveMembers account={account} /> : <MembersSection account={account} data={data} />)}
            {s.id === 'domains' && <DomainsSection account={account} />}
            {s.id === 'migration' && <MigrationSection account={account} />}
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

// ---------------------------------------------------------------------------------------------------------------
// Migration: the Google Workspace import runs on its own page (/migrate/); this shows where it stands.

const MIGRATION_STAGES: Record<MigrationStage, string> = {
  connect: 'Not started',
  discover: 'Connected to Google',
  plan: 'Planning',
  review: 'Ready to start',
  copying: 'Copying from Google',
  switch: 'Ready to switch',
  final: 'Final sync running',
  finish: 'Finishing up',
  done: 'Finished',
}

const migrationUrl = () => `/migrate/${isDemo() ? '?demo' : ''}`

function migrationSub(account: Account): string {
  const m = migrationSummary(account.org.id)
  if (!m || m.stage === 'connect') return 'Import from Google Workspace'
  return m.percent !== null ? `${MIGRATION_STAGES[m.stage]} · ${m.percent}%` : MIGRATION_STAGES[m.stage]
}

function MigrationSection({ account }: { account: Account }) {
  const admin = isOrgAdmin(account.org)
  const m = migrationSummary(account.org.id)
  const started = !!m && m.stage !== 'connect'
  // After an import ends, a reminder until xstate's access to Google Workspace is removed.
  const [reminder, setReminder] = useState<AccessReminder>({ open: false })
  useEffect(() => {
    if (account.mode !== 'live' || !admin) return
    accessReminder(account.org.id).then(setReminder, () => undefined)
  }, [account.mode, account.org.id, admin])
  return (
    <div className="group">
      <GroupHead
        title="Import from Google Workspace"
        sub="Move every user's mail, contacts, calendars and Drive files from Google Workspace to xstate. xstate only reads from Google; nothing there is changed or deleted."
      />
      <div className="card">
        <div className="card-row">
          <span className="lead">
            <Icon name="download" size={15} />
          </span>
          <div className="text">
            <span className="name">{started ? MIGRATION_STAGES[m.stage] : 'Google Workspace'}</span>
            <span className="sub">
              {!started
                ? 'Mail with labels and attachments, contacts, calendars, My Drive and Shared drives.'
                : m.stage === 'done'
                  ? 'Everything was moved. The report stays available on the migration page.'
                  : m.percent !== null
                    ? `${m.percent}% copied. You can leave and come back; copying keeps running.`
                    : 'Pick up where you left off.'}
            </span>
          </div>
          <div className="right">
            {admin || started ? (
              <a className="btn btn-primary" style={{ height: 34 }} href={migrationUrl()}>
                {!started ? 'Start import' : m.stage === 'done' ? 'View report' : 'Open'}
              </a>
            ) : (
              <span>Only owners and admins can start an import.</span>
            )}
          </div>
        </div>
        {reminder.open && (
          <div className="card-row is-warn">
            <span className="lead">
              <Icon name="circle-alert" size={15} />
            </span>
            <div className="text">
              <span className="name">xstate can still read {reminder.domain ?? 'your Google Workspace'}</span>
              <span className="sub">
                {reminder.ended === 'finished' ? 'The import is finished. ' : 'The import was cancelled. Unless you’ll import again, '}
                In the Google Admin console, go to Security → API controls → Domain-wide delegation and delete xstate’s client ID. This note
                goes away once Google stops accepting it.
              </span>
            </div>
            <div className="right">
              <a className="btn" style={{ height: 34 }} href="https://admin.google.com/ac/owl/domainwidedelegation" target="_blank" rel="noreferrer">
                Open Google Admin
              </a>
            </div>
          </div>
        )}
      </div>
    </div>
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

const canManageMembers = (account: Account) => isOrgAdmin(account.org)

function sentLabel(m: OrgMember): string {
  if (!m.invite) return ''
  if (Date.parse(m.invite.expiresAt) < Date.now()) return 'Invite expired'
  if (!m.invite.sentAt) return 'Invite not sent yet'
  const day = new Date(m.invite.sentAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  return `Invited ${day}`
}

/** What happened to the invite email, as a line under the form. */
type InviteNote = { email: string; sent: boolean; reason?: string; url?: string } | null

function LiveMembers({ account }: { account: Account }) {
  const client = useQueryClient()
  const orgId = account.org.id
  const query = useMembers(orgId, true)
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<'admin' | 'member'>('member')
  const [error, setError] = useState('')
  const [sending, setSending] = useState(false)
  const [note, setNote] = useState<InviteNote>(null)
  const [removing, setRemoving] = useState<OrgMember | null>(null)
  const manage = canManageMembers(account)
  const rows = query.data ?? []

  const report = (to: string, delivery: { sent: boolean; reason?: string; inviteUrl?: string }) => {
    setNote({ email: to, sent: delivery.sent, reason: delivery.reason, url: delivery.inviteUrl })
    if (delivery.sent) toast(`Invite sent to ${to}`)
  }

  const invite = async (event: FormEvent) => {
    event.preventDefault()
    const value = email.trim().toLowerCase()
    if (!isEmail(value)) return setError('Enter a valid email address.')
    if (rows.some((m) => m.email === value)) return setError(`${value} is already on the team.`)
    setError('')
    setSending(true)
    try {
      const result = await inviteMember(client, orgId, { email: value, role })
      setEmail('')
      report(value, result.email)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setSending(false)
    }
  }

  const resend = async (m: OrgMember) => {
    try {
      report(m.email, (await resendInvite(client, orgId, m.id)).email)
    } catch (err) {
      toast(errorMessage(err))
    }
  }

  const changeRole = async (m: OrgMember, next: 'admin' | 'member') => {
    try {
      await setMemberRole(client, orgId, m.id, next)
      toast('Role updated')
    } catch (err) {
      toast(errorMessage(err))
    }
  }

  return (
    <>
      {manage && (
        <div className="group">
          <GroupHead title="Invite" sub="Members can use the shared inbox, storage and agents. Admins can also manage members, billing and secrets." />
          <form className="inline-form invite-form" noValidate onSubmit={(e) => void invite(e)}>
            <input
              className="text-input"
              type="email"
              placeholder="name@company.com"
              aria-label="Email to invite"
              autoComplete="off"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <select className="select" aria-label="Role" value={role} onChange={(e) => setRole(e.target.value as 'admin' | 'member')}>
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </select>
            <button className="btn btn-primary" style={{ height: 34 }} disabled={sending} aria-busy={sending || undefined}>
              Send invite
            </button>
          </form>
          <div className="form-error" role="alert">
            {error}
          </div>
          {note && !note.sent && (
            <div className="invite-note" role="status">
              <Icon name="circle-alert" size={14} />
              <span>
                The invite to {note.email} wasn't emailed: {note.reason ?? 'unknown reason'}.
                {note.url ? ' Share this link with them instead:' : ' Try sending it again.'}
                {note.url && (
                  <span className="invite-link">
                    <code className="ellipsis">{note.url}</code>
                    <button className="btn btn-sm" type="button" onClick={() => void copyText(note.url!).then((ok) => ok && toast('Link copied'))}>
                      Copy
                    </button>
                  </span>
                )}
              </span>
            </div>
          )}
        </div>
      )}
      <div className="group">
        <GroupHead title="Members" />
        {query.isError ? (
          <div className="form-error" role="alert">
            {errorMessage(query.error)}
          </div>
        ) : (
          <div className="card">
            {query.isPending && (
              <div className="card-row">
                <span className="spinner" />
              </div>
            )}
            {rows.map((m) => {
              const invited = m.status === 'invited'
              const label = m.name || m.email
              const editable = manage && m.role !== 'owner'
              return (
                <div className="card-row member-row" key={m.id}>
                  <span className="avatar md">{invited && !m.name ? m.email[0]!.toUpperCase() : initials(label)}</span>
                  <div className="text">
                    <span className="name ellipsis">
                      {label}
                      {m.you && <span className="muted"> (you)</span>}
                    </span>
                    <span className="sub ellipsis">{invited ? `${m.name ? `${m.email} · ` : ''}${sentLabel(m)}` : m.email}</span>
                  </div>
                  <span className="right">
                    {invited && manage && (
                      <button className="btn btn-sm btn-quiet" onClick={() => void resend(m)}>
                        {m.invite?.sentAt ? 'Send again' : 'Send invite'}
                      </button>
                    )}
                    {editable ? (
                      <>
                        <select
                          className="select sm"
                          aria-label={`Role for ${label}`}
                          value={m.role}
                          onChange={(e) => void changeRole(m, e.target.value as 'admin' | 'member')}
                        >
                          <option value="admin">Admin</option>
                          <option value="member">Member</option>
                        </select>
                        <button className="x-btn" aria-label={invited ? `Cancel invite for ${label}` : `Remove ${label}`} onClick={() => setRemoving(m)}>
                          <Icon name="x" size={14} />
                        </button>
                      </>
                    ) : (
                      cap(m.role)
                    )}
                  </span>
                </div>
              )
            })}
          </div>
        )}
      </div>
      {removing && (
        <ConfirmDialog
          title={removing.status === 'invited' ? 'Cancel invite' : 'Remove member'}
          body={
            removing.status === 'invited'
              ? `Cancel the invite for ${removing.email}? Their invite link stops working.`
              : `Remove ${removing.name || removing.email} from ${account.org.name}? They lose access right away, and their own My Files are deleted.`
          }
          action={removing.status === 'invited' ? 'Cancel invite' : 'Remove'}
          onClose={() => setRemoving(null)}
          onConfirm={async () => {
            try {
              await removeMember(client, orgId, removing.id)
              toast(removing.status === 'invited' ? 'Invite cancelled' : 'Member removed')
            } catch (err) {
              toast(errorMessage(err))
            }
          }}
        />
      )}
    </>
  )
}

/** Demo mode: the sample members, changed in memory. */
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
        <GroupHead title="Invite" sub="Members can use the shared inbox, storage and agents. Admins can also manage billing and secrets." />
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
  // The domain being added, while the request runs (empty when idle).
  const [adding, setAdding] = useState('')

  const add = async (event: FormEvent) => {
    event.preventDefault()
    if (adding) return
    const value = name.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
    if (!DOMAIN_RE.test(value)) return setError('Enter a domain like example.com.')
    if (account.domains.some((d) => d.name === value)) return setError(`${value} is already added.`)
    setError('')
    setAdding(value)
    try {
      await addDomain(client, value)
      toast(`${value} added. Add its DNS records to verify it.`)
      setName('')
      setError('')
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setAdding('')
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
          readOnly={!!adding}
          onChange={(e) => setName(e.target.value)}
        />
        <button className="btn btn-primary" style={{ height: 34 }} disabled={!!adding} aria-busy={!!adding}>
          {adding && <span className="spinner spinner-on-primary" />}
          {adding ? 'Adding…' : 'Add domain'}
        </button>
      </form>
      <div className="form-status" role="status" aria-live="polite">
        {adding && `Adding ${adding}: creating its mail domain and signing keys. This takes a few seconds.`}
      </div>
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
      if (verified) toast(domain?.sending === 'verified' ? 'Sending ready.' : 'Sending is still pending: Amazon SES has not seen the DKIM records yet.')
      else toast(domain?.status === 'verified' ? 'Verified. Mail is on.' : 'Some records are still missing.')
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

  const copy = async (value: string) => copied(await copyText(value))
  const copied = (ok: boolean) => toast(ok ? 'Copied' : "Couldn't copy")

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
            <>
              <span className="status">
                <Icon name="circle-check" size={14} />
                Verified
              </span>
              {/* SES checks DKIM on its own schedule; the API also refreshes this hourly. */}
              {(d.sending === 'pending' || d.sending === 'failed') && (
                <button className="btn" disabled={checking} aria-busy={checking} onClick={() => void check()}>
                  Check sending
                </button>
              )}
            </>
          ) : (
            <>
              {/* Owned (the ownership TXT record) but mail not moved yet: what an import from Google needs to start. */}
              <span className={`status${d.owned ? '' : ' pending'}`} title={d.owned ? 'Proven to be yours. Mail moves when its records are in place.' : undefined}>
                <Icon name={d.owned ? 'circle-check' : 'clock'} size={14} />
                {d.owned ? 'Ownership proven' : 'Pending DNS'}
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
          {records.some((r) => r.purpose === 'Ownership') && (
            <p className="records-note">
              Moving from Google Workspace? The first record (TXT, xstate-verification) only proves the domain is yours, so you can start the import
              while mail still goes to Google. Add the mail records when you switch.
            </p>
          )}
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
                  <td>
                    <RecordCell label={`${r.type} name`} text={r.name} onCopied={copied} />
                  </td>
                  <td>
                    <RecordCell label={`${r.type} value`} text={r.value} onCopied={copied} />
                  </td>
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
      <DomainMailboxes account={account} domain={d} />
    </>
  )
}

const KIND_LABEL: Record<MailboxKind, string> ={ personal: 'Personal', shared: 'Shared', agent: 'Agent' }
const KIND_HINT: Record<MailboxKind, string> = {
  personal: "One person's inbox. They open it in xstate or any mail app.",
  shared: 'For addresses like hello@ or support@. No password: you get access now, and can give it to others later.',
  agent: 'For an AI agent. It signs in with the password shown after you create it.',
}
const LOCAL_PART_RE = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/

/** The mailboxes on one domain, and (for admins) a form to add another. */
function DomainMailboxes({ account, domain: d }: { account: Account; domain: Domain }) {
  const mailboxes = mailboxesOf(account, d.id).sort((a, b) => a.address.localeCompare(b.address))
  const admin = isOrgAdmin(account.org)
  const [open, setOpen] = useState(false)
  const [created, setCreated] = useState<{ address: string; password: string } | null>(null)
  if (!mailboxes.length && !admin) return null

  return (
    <div className="domain-mailboxes">
      {mailboxes.map((m) => (
        <div className="mbx-row" key={m.id}>
          <Icon name={m.kind === 'shared' ? 'users' : m.kind === 'agent' ? 'bot' : 'mail'} size={13} />
          <span className="mbx-address">{m.address}</span>
          {m.displayName && <span className="mbx-name">{m.displayName}</span>}
          <span className="mbx-kind">{KIND_LABEL[m.kind]}</span>
        </div>
      ))}
      {created && (
        <div className="mbx-password" role="status">
          <span>
            Password for <b>{created.address}</b>, shown only once. Use it to sign in from other mail apps.
          </span>
          <code>{created.password}</code>
          <button className="btn" onClick={() => void copyText(created.password).then((ok) => toast(ok ? 'Copied' : "Couldn't copy"))}>
            Copy
          </button>
          <button className="btn" onClick={() => setCreated(null)}>
            Done
          </button>
        </div>
      )}
      {admin &&
        (open ? (
          <AddMailboxForm
            account={account}
            domain={d}
            onClose={() => setOpen(false)}
            onCreated={(address, password) => {
              setOpen(false)
              if (password) setCreated({ address, password })
            }}
          />
        ) : (
          <button className="text-btn mbx-add" onClick={() => setOpen(true)}>
            <Icon name="plus" size={12} />
            Add mailbox
          </button>
        ))}
    </div>
  )
}

function AddMailboxForm({
  account,
  domain: d,
  onClose,
  onCreated,
}: {
  account: Account
  domain: Domain
  onClose: () => void
  onCreated: (address: string, password?: string) => void
}) {
  const client = useQueryClient()
  const live = account.mode === 'live'
  const members = useMembers(account.org.id, live)
  const people: { id: string; label: string }[] = live
    ? (members.data ?? []).map((m) => ({ id: m.id, label: `${m.name ?? m.email}${m.status === 'invited' ? ' (invited)' : ''}` }))
    : [{ id: account.org.memberId ?? 'me', label: account.user.name ?? account.user.email }]
  const [local, setLocal] = useState('')
  const [kind, setKind] = useState<MailboxKind>('personal')
  const [owner, setOwner] = useState('')
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const localRef = useRef<HTMLInputElement>(null)
  useEffect(() => localRef.current?.focus(), [])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const localPart = local.trim().toLowerCase()
    const address = `${localPart}@${d.name}`
    if (!LOCAL_PART_RE.test(localPart) || localPart.includes('..')) return setError('Use letters, numbers, dots, dashes and underscores, like jane or support.')
    if (account.mailboxes.some((m) => m.address === address)) return setError(`${address} already exists.`)
    if (kind === 'personal' && !owner) return setError('Choose whose inbox this is.')
    setSaving(true)
    setError('')
    try {
      const { password } = await createMailbox(client, d.id, {
        kind,
        localPart,
        ...(name.trim() && { displayName: name.trim() }),
        ...(kind === 'personal' && { ownerMemberId: owner }),
      })
      toast(`${address} created`)
      onCreated(address, password)
    } catch (e) {
      setError(errorMessage(e))
      setSaving(false)
    }
  }

  return (
    <form className="mbx-form" noValidate onSubmit={(e) => void submit(e)} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <div className="mbx-form-row">
        <label className="mbx-local">
          <input
            ref={localRef}
            className="text-input"
            placeholder="jane"
            aria-label="Address"
            autoCapitalize="off"
            autoComplete="off"
            spellCheck={false}
            value={local}
            onChange={(e) => setLocal(e.target.value)}
          />
          <span className="mbx-at">@{d.name}</span>
        </label>
        <select className="select" aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value as MailboxKind)}>
          <option value="personal">Personal</option>
          <option value="shared">Shared</option>
          <option value="agent">Agent</option>
        </select>
      </div>
      <p className="mbx-hint">{KIND_HINT[kind]}</p>
      <div className="mbx-form-row">
        {kind === 'personal' && (
          <select className="select" aria-label="Owner" value={owner} onChange={(e) => setOwner(e.target.value)} disabled={live && members.isLoading}>
            <option value="">{live && members.isLoading ? 'Loading members…' : 'Whose inbox?'}</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        )}
        <input className="text-input" placeholder="Display name (optional)" aria-label="Display name" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      <div className="mbx-form-actions">
        <button className="btn btn-primary" disabled={saving} aria-busy={saving}>
          {saving ? 'Creating…' : 'Create mailbox'}
        </button>
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
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
  const admin = isOrgAdmin(account.org)
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
