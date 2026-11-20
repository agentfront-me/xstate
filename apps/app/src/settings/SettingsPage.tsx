// Settings: Account, Members, Domains, Migration, Connected apps, AI providers, Secrets, API keys, Billing, Integrations.
//
// Account, Members, Domains, AI providers, Secrets and API keys use the API when signed in (AI providers and Secrets
// live in ./AiSections; Billing in ./Billing; API keys → Personal Tokens in ./PersonalTokens). Integrations have no API yet: it shows sample data (./store), marked
// "Sample data" in the header when signed in, and changes stay in memory.
// In demo mode (?demo) every section uses sample data.

import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Icon, type IconName } from '../components/Icon'
import { RecordCell } from '../components/RecordCell'
import { toast } from '../components/Toast'
import { addDomain, isDemo, isOrgAdmin, mailboxesOf, removeDomain, useAccount, verifyDomain, type Account } from '../lib/account'
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
import { accessReminder, startNew as startNewMigration, summary as migrationSummary, type AccessReminder } from '../migration/api'
import type { Stage as MigrationStage } from '../migration/types'
import type { Domain } from '../lib/types'
import { ConfirmDialog } from '../storage/dialogs'
import { type ApiKeys, keysApi } from '../users/api'
import { CodeBlock, snippetFor } from '../users/UsersPage'
import { AddMemberDialog, MemberDialog, SharedMailboxesSection } from './MemberDialogs'
import { membersSub, removeMember, useMembers, type OrgMember } from './members'
import { AiProvidersSection, LiveSecretsSection } from './AiSections'
import { BillingSection as LiveBillingSection } from './Billing'
import { ConnectedAppsSection } from './ConnectedApps'
import { ConnectorsSection } from './Connectors'
import { PersonalTokens } from './PersonalTokens'
import { setSettings, useSettingsData, type SettingsData } from './store'

type Section = {
  id: 'account' | 'members' | 'domains' | 'access' | 'agent-setup' | 'billing'
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
      // A Google Workspace import in progress shows here too: its section is on this page.
      const importing = importingSub(a)
      if (!n) return importing || 'No domains yet'
      return `${a.domains.filter((d) => d.status === 'verified').length} of ${n} verified${importing && ` · ${importing}`}`
    },
  },
  // What can reach into xstate: AI apps people connected, the organization's keys, personal tokens.
  { id: 'access', label: 'Apps and API', icon: 'code', sub: () => 'Connected AI apps, API keys and tokens' },
  // What agents use to reach out: AI accounts, MCP servers, and the secrets those send.
  {
    id: 'agent-setup',
    label: 'Agent setup',
    icon: 'sparkles',
    sub: (a, d) => (a.mode === 'live' ? 'AI providers, connectors and secrets' : `${d.integrations.filter((i) => i.connected).length} connected · ${d.secrets.length} secrets`),
  },
  {
    id: 'billing',
    label: 'Billing',
    icon: 'credit-card',
    sub: (a, d) => (a.mode === 'live' ? 'Plan, payment and invoices' : `${d.billing.plan} · renews ${d.billing.renewsShort}`),
  },
]

/** Pages with tabs. `admins`: only owners and admins see the tab. */
const TABS: Partial<Record<Section['id'], { id: string; label: string; admins?: boolean }[]>> = {
  access: [
    { id: 'connected-apps', label: 'Connected apps' },
    { id: 'org-keys', label: 'Organization keys', admins: true },
    { id: 'tokens', label: 'Personal tokens' },
  ],
  'agent-setup': [
    { id: 'ai-providers', label: 'AI providers' },
    { id: 'connectors', label: 'Connectors' },
    { id: 'secrets', label: 'Secrets' },
  ],
}

/**
 * Sections that became part of another page: the old address (#/settings/secrets, in emails, redirects and links
 * across the app) opens that page on the right tab, or scrolled to the part.
 */
const MOVED: Record<string, { to: Section['id']; tab?: string; part?: string }> = {
  migration: { to: 'domains', part: 'google-import' },
  'connected-apps': { to: 'access', tab: 'connected-apps' },
  // Emails about personal tokens link to api-keys.
  'api-keys': { to: 'access', tab: 'tokens' },
  'org-keys': { to: 'access', tab: 'org-keys' },
  'ai-providers': { to: 'agent-setup', tab: 'ai-providers' },
  connectors: { to: 'agent-setup', tab: 'connectors' },
  secrets: { to: 'agent-setup', tab: 'secrets' },
}

export function SettingsPage({ section, tab: wantedTab }: { section: string; tab?: string }) {
  const account = useAccount()
  const data = useSettingsData()
  const navigate = useNavigate()
  const moved = MOVED[section]
  const toImport = section === 'migration'
  const s = SECTIONS.find((x) => x.id === (moved?.to ?? section)) ?? SECTIONS[0]!
  const part = moved?.part
  useEffect(() => {
    if (part) document.getElementById(part)?.scrollIntoView({ block: 'start' })
  }, [part])
  // The page's tabs this person may see, and the open one: from an old address, else the address's ?tab=, else the first.
  const tabs = (TABS[s.id] ?? []).filter((t) => !t.admins || isOrgAdmin(account.org))
  const tab = tabs.find((t) => t.id === (moved?.tab ?? wantedTab))?.id ?? tabs[0]?.id
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
            {s.id === 'domains' && (
              <>
                <DomainsSection account={account} />
                <MigrationSection account={account} startOpen={toImport} />
              </>
            )}
            {tabs.length > 0 && (
              <nav className="set-tabs" role="tablist" aria-label={s.label}>
                {tabs.map((t) => (
                  <button
                    key={t.id}
                    role="tab"
                    id={`tab-${t.id}`}
                    aria-selected={t.id === tab}
                    onClick={() => void navigate({ to: '/settings/$section', params: { section: s.id }, search: { tab: t.id } })}
                  >
                    {t.label}
                  </button>
                ))}
              </nav>
            )}
            {tabs.length > 0 && (
              // The tab names the section, so the section's own heading is hidden in here (dashboard.css).
              <div className="tab-panel" role="tabpanel" aria-labelledby={`tab-${tab}`} key={tab}>
                {tab === 'connected-apps' && <ConnectedAppsSection account={account} />}
                {tab === 'org-keys' && <OrgKeys account={account} />}
                {tab === 'tokens' &&
                  (account.mode === 'live' ? <PersonalTokens orgId={account.org.id} admin={isOrgAdmin(account.org)} /> : <p className="muted">Sign in to see your personal tokens.</p>)}
                {tab === 'ai-providers' && <AiProvidersSection account={account} />}
                {tab === 'connectors' && (account.mode === 'live' ? <ConnectorsSection account={account} /> : <IntegrationsSection data={data} />)}
                {tab === 'secrets' && (account.mode === 'live' ? <LiveSecretsSection account={account} /> : <SecretsSection data={data} />)}
              </div>
            )}
            {s.id === 'billing' && (account.mode === 'live' ? <LiveBillingSection account={account} /> : <BillingSection data={data} />)}
          </div>
        </div>
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Migration: the Google Workspace import runs on its own page (/migrate/); this shows where it stands, as the second
// section of Domains (#/settings/migration still opens it).

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

/** An import that is under way, for the Domains menu item: "Importing 42%". Empty before one starts and after it ends. */
function importingSub(account: Account): string {
  const m = migrationSummary(account.org.id)
  if (!m || m.stage === 'connect' || m.stage === 'done') return ''
  return m.percent !== null ? `Importing ${m.percent}%` : `Import: ${MIGRATION_STAGES[m.stage].toLowerCase()}`
}

function MigrationSection({ account, startOpen }: { account: Account; startOpen: boolean }) {
  const admin = isOrgAdmin(account.org)
  const m = migrationSummary(account.org.id)
  const started = !!m && m.stage !== 'connect'
  // A link until it's clicked. It stays open on its own while there's something to see: an import under way, or
  // the reminder that xstate can still read Google.
  const [opened, setOpened] = useState(startOpen)
  useEffect(() => {
    if (startOpen) setOpened(true)
  }, [startOpen])
  // After an import ends, a reminder until xstate's access to Google Workspace is removed.
  const [reminder, setReminder] = useState<AccessReminder>({ open: false })
  const [startingNew, setStartingNew] = useState(false)
  // Done → a fresh import from Connect. The finished one's report stays on the server until its cleanup.
  const importAnother = async () => {
    setStartingNew(true)
    try {
      await startNewMigration(account.org.id)
      location.href = migrationUrl()
    } catch (e) {
      toast(errorMessage(e))
      setStartingNew(false)
    }
  }
  useEffect(() => {
    if (account.mode !== 'live' || !admin) return
    accessReminder(account.org.id).then(setReminder, () => undefined)
  }, [account.mode, account.org.id, admin])
  const underWay = started && m.stage !== 'done'
  const open = opened || underWay || reminder.open
  if (!open) {
    return (
      <div className="group" id="google-import">
        <button className="link-toggle" aria-expanded={false} onClick={() => setOpened(true)}>
          <Icon name="download" size={14} />
          Import from Google Workspace
          <Icon name="chevron-right" size={13} />
        </button>
      </div>
    )
  }
  return (
    <div className="group" id="google-import">
      <GroupHead
        aside={
          !underWay &&
          !reminder.open && (
            <button className="link-toggle" aria-expanded onClick={() => setOpened(false)}>
              Hide
              <Icon name="chevron-down" size={13} />
            </button>
          )
        }
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
            {admin && m?.stage === 'done' && (
              <button className="btn" style={{ height: 34 }} disabled={startingNew} aria-busy={startingNew} onClick={() => void importAnother()}>
                {startingNew ? <span className="spinner" /> : <Icon name="plus" size={14} />}
                Import another
              </button>
            )}
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

/** The line under a member's name: their sign-in, how many domains they're on, and invite state. */
function memberSub(m: OrgMember): string {
  const domains = new Set(m.mailboxes.flatMap((b) => b.addresses.map((a) => a.domainId))).size
  const parts = [m.email]
  if (domains > 1) parts.push(`${domains} domains`)
  if (m.status === 'invited') parts.push(sentLabel(m))
  return parts.join(' · ')
}

function LiveMembers({ account }: { account: Account }) {
  const client = useQueryClient()
  const orgId = account.org.id
  const query = useMembers(orgId, true)
  const [adding, setAdding] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)
  const [removing, setRemoving] = useState<OrgMember | null>(null)
  const manage = canManageMembers(account)
  const rows = query.data ?? []
  const open = rows.find((m) => m.id === openId) ?? null

  return (
    <>
      <div className="group">
        <GroupHead
          title="Members"
          sub="Members can use the shared inbox, storage and agents. Admins can also manage members, billing and secrets."
          aside={
            manage && (
              <button className="btn btn-primary" onClick={() => setAdding(true)}>
                <Icon name="plus" size={14} />
                Add member
              </button>
            )
          }
        />
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
              return (
                <button className={`card-row member-row${m.suspendedAt ? ' is-suspended' : ''}`} key={m.id} onClick={() => setOpenId(m.id)}>
                  <span className="avatar md">{invited && !m.name ? m.email[0]!.toUpperCase() : initials(label)}</span>
                  <div className="text">
                    <span className="name ellipsis">
                      {label}
                      {m.you && <span className="muted"> (you)</span>}
                    </span>
                    <span className="sub ellipsis">{memberSub(m)}</span>
                  </div>
                  <span className="right">
                    {invited && <span className="tag">Invite pending</span>}
                    {m.suspendedAt && <span className="tag">{m.deleteAfter ? 'Being deleted' : 'Suspended'}</span>}
                    <span className="muted">{cap(m.role)}</span>
                    <Icon name="chevron-right" size={14} />
                  </span>
                </button>
              )
            })}
          </div>
        )}
      </div>
      <SharedMailboxesSection account={account} />
      {adding && <AddMemberDialog account={account} onClose={() => setAdding(false)} />}
      {open && !removing && (
        <MemberDialog
          account={account}
          member={open}
          onClose={() => setOpenId(null)}
          onRemove={(m) => setRemoving(m)}
        />
      )}
      {removing && (
        <ConfirmDialog
          title={removing.status === 'invited' ? 'Cancel invite' : 'Remove member'}
          body={
            removing.status === 'invited'
              ? `Cancel the invite for ${removing.name || removing.email}? Their invite link stops working.`
              : `Remove ${removing.name || removing.email} from ${account.org.name}? They lose access right away, and their own My Files are deleted.`
          }
          action={removing.status === 'invited' ? 'Cancel invite' : 'Remove'}
          onClose={() => setRemoving(null)}
          onConfirm={async () => {
            try {
              await removeMember(client, orgId, removing.id)
              setOpenId(null)
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
      <GroupHead title="Email domains" sub="Mail is sent and received on verified domains. Mailboxes are added in Members." />
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

/** What works on this domain: receiving (its DNS records) and sending to outside addresses (Amazon SES verification). */
function statusLine(d: Domain): string {
  if (d.status !== 'verified') return d.owned ? 'Not receiving yet: add the mail records when you switch' : 'Not receiving yet: add the DNS records below'
  if (d.sending === 'verified') return 'Receiving and sending ready'
  if (d.sending === 'failed') return 'Receiving ready · sending failed: check the DKIM records'
  if (d.sending === 'pending') return 'Receiving ready · sending pending: waiting for DKIM records'
  return 'Receiving ready'
}

function DomainRow({ account, domain: d }: { account: Account; domain: Domain }) {
  const client = useQueryClient()
  const [checking, setChecking] = useState(false)
  const [removing, setRemoving] = useState(false)
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
    // The server refuses while any address is on the domain, so say what to delete first instead of asking.
    const boxes = mailboxesOf(account, d.id)
    if (boxes.length) {
      const shared = boxes.filter((m) => m.kind === 'shared').map((m) => m.address)
      const personal = boxes.filter((m) => m.kind !== 'shared').map((m) => m.address)
      alert(
        [
          `${d.name} still has ${boxes.length} ${boxes.length === 1 ? 'mailbox' : 'mailboxes'}. Delete ${boxes.length === 1 ? 'it' : 'them'} first, then remove the domain.`,
          shared.length ? `\nShared (delete in Members → Shared mailboxes):\n${shared.join('\n')}` : '',
          personal.length ? `\nPersonal (delete the member in Members):\n${personal.join('\n')}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      )
      return
    }
    if (!confirm(`Remove ${d.name}? Mail to it will stop being received.`)) return
    setRemoving(true)
    try {
      await removeDomain(client, d.id)
      toast(`${d.name} removed`)
    } catch (e) {
      toast(errorMessage(e))
      setRemoving(false)
    }
  }

  const copied = (ok: boolean, label: string) => toast(ok ? `Copied ${label}` : "Couldn't copy")

  return (
    <>
      <div className="card-row">
        <span className="lead">
          <Icon name="at-sign" size={16} />
        </span>
        <div className="text">
          <span className="name">{d.name}</span>
          <span className="sub">{statusLine(d)}</span>
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
            <colgroup>
              <col className="col-state" />
              <col className="col-type" />
              <col className="col-name" />
              <col />
            </colgroup>
            <thead>
              <tr>
                <th aria-label="Status" />
                <th>Type</th>
                <th>Name</th>
                <th>Value</th>
              </tr>
            </thead>
            <tbody>
              {records.map((r, i) => (
                <tr key={i} className={r.found ? 'found' : undefined}>
                  <td>
                    <span className="record-state" title={r.found ? 'Record found' : 'Waiting for record'}>
                      <Icon name={r.found ? 'circle-check' : 'clock'} size={14} />
                    </span>
                  </td>
                  <td>{r.type}</td>
                  <td>
                    <RecordCell label={`${r.type} name`} text={r.name} onCopied={copied} />
                  </td>
                  <td>
                    <RecordCell label={`${r.type} value`} text={r.value} onCopied={copied} />
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
// API keys, in two tabs. Organization Keys: the organization's publishable and secret key, for tracking in the
// Users section; owners and admins only. Personal Tokens: each member's own tokens for sending email from their
// server (./PersonalTokens); everyone.

function OrgKeys({ account }: { account: Account }) {
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
          title="Organization keys"
          sub="Keys for your organization. Use the publishable key in browsers and client apps to identify visitors and track events. Keep the secret key on your servers; it has full access to your organization's users and segments. To send email from a server, use a personal token."
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
                <span className="sub">Server-side only. Full access to your organization's users and segments.</span>
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
              Renews {b.renews}. Up to {b.people.toLocaleString('en-US')} people a month, no charge per seat.
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
