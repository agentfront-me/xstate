// Dashboard shell: the rail on the left and the current page. Also wires ⌘K, the desktop app's menu commands
// and the unread and approval badges.

import { Outlet, useNavigate, useRouter, useRouterState } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { ApprovalAlerts, usePendingApprovals } from '../agents/alerts'
import { Icon } from '../components/Icon'
import { useAccount } from '../lib/account'
import { desktop, initials, isMac } from '../lib/core'
import { setDomainScope, useDomainScope } from '../lib/scope'
import { MailSync, useScopedUnreadCount, useUnreadCount } from '../mail/data'
import { requestMail } from '../mail/intents'
import { PAGES, ROUTED } from './pages'

const COLLAPSED_KEY = 'xstate.rail-collapsed'

// In the desktop app the window has no title bar: macOS traffic lights sit over the rail, and on Windows and Linux
// the window controls overlay the top right corner.
if (desktop) document.documentElement.classList.add(desktop.platform === 'darwin' ? 'is-mac' : 'has-overlay')

export function Shell() {
  const navigate = useNavigate()

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        void navigate({ to: '/mail' })
        requestMail('search')
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [navigate])

  useEffect(() => {
    // The desktop app's menu (Settings…, New mail) and tray send these.
    desktop?.onCommand?.((command) => {
      if (command === 'settings') void navigate({ to: '/settings/$section', params: { section: 'account' } })
      if (command === 'new-mail') {
        void navigate({ to: '/mail' })
        requestMail('compose')
      }
    })
  }, [navigate])

  return (
    <div className="app">
      <MailSync />
      <ApprovalAlerts />
      <Rail />
      <main className="main">
        <Outlet />
      </main>
    </div>
  )
}

/** Back and forward walk the browser history; the router keeps our position in it (__TSR_index). */
function useHistoryButtons() {
  const router = useRouter()
  const index = useRouterState({ select: (s) => (s.location.state as { __TSR_index?: number }).__TSR_index ?? 0 })
  const [max, setMax] = useState(index)
  useEffect(
    () =>
      router.history.subscribe(({ action }) => {
        const i = (router.history.location.state as { __TSR_index?: number }).__TSR_index ?? 0
        setMax((m) => (action.type === 'PUSH' ? i : Math.max(m, i)))
      }),
    [router],
  )
  return { canBack: index > 0, canForward: index < max, back: () => router.history.back(), forward: () => router.history.forward() }
}

function Rail() {
  const account = useAccount()
  const navigate = useNavigate()
  const path = useRouterState({ select: (s) => s.location.pathname })
  const page = path.split('/')[1] || 'mail'
  const unread = useScopedUnreadCount()
  const totalUnread = useUnreadCount()
  const approvals = usePendingApprovals()
  const history = useHistoryButtons()
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSED_KEY) === '1'
    } catch {
      return false
    }
  })

  useEffect(() => {
    desktop?.setUnread(totalUnread)
  }, [totalUnread])

  const toggle = () => {
    setCollapsed((c) => {
      try {
        localStorage.setItem(COLLAPSED_KEY, c ? '0' : '1')
      } catch {
        // Not remembered.
      }
      return !c
    })
  }

  const name = account.user.name || account.user.email
  return (
    <aside className={`rail${collapsed ? ' is-collapsed' : ''}`} aria-label="Main">
      <div className="rail-top drag">
        <button className="ghost" onClick={toggle} title="Toggle sidebar" aria-label="Toggle sidebar">
          <Icon name="panel-left" size={16} />
        </button>
        <span className="history" style={{ display: 'flex', gap: 2 }}>
          <button className="ghost" aria-label="Back" disabled={!history.canBack} onClick={history.back}>
            <Icon name="chevron-left" size={16} />
          </button>
          <button className="ghost" aria-label="Forward" disabled={!history.canForward} onClick={history.forward}>
            <Icon name="chevron-right" size={16} />
          </button>
        </span>
        <DomainPicker />
      </div>
      <nav className="nav">
        <button
          className="nav-item"
          title="Search"
          onClick={() => {
            void navigate({ to: '/mail' })
            requestMail('search')
          }}
        >
          <Icon name="search" size={16} />
          <span className="label">Search</span>
          <kbd>{isMac ? '⌘K' : 'Ctrl K'}</kbd>
        </button>
        {PAGES.map((p) => (
          <button
            key={p.id}
            className="nav-item"
            title={p.label}
            aria-current={page === p.id ? 'page' : undefined}
            onClick={() =>
              void (ROUTED.has(p.id)
                ? navigate({ to: `/${p.id}` })
                : navigate({ to: '/$page', params: { page: p.id } }))
            }
          >
            <Icon name={p.icon} size={16} />
            <span className="label">{p.label}</span>
            {p.id === 'mail' && unread > 0 && <span className="count">{unread}</span>}
            {p.id === 'agents' && approvals > 0 && <span className="count" title={`${approvals} waiting for approval`}>{approvals}</span>}
          </button>
        ))}
      </nav>
      <div className="rail-foot">
        <button
          className="me"
          title="Settings"
          aria-current={page === 'settings' ? 'page' : undefined}
          onClick={() => void navigate({ to: '/settings/$section', params: { section: 'account' } })}
        >
          <span className="avatar">{initials(name)[0]}</span>
          <span className="name ellipsis">{name}</span>
          <span className="plan">{account.org.plan ?? 'Free'}</span>
          <Icon name="chevron-down" size={14} />
        </button>
      </div>
    </aside>
  )
}

/** Picks the domain that Email, Agents and Users show. */
function DomainPicker() {
  const account = useAccount()
  const scope = useDomainScope()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const pick = (id: string | null) => {
    setDomainScope(id)
    setOpen(false)
  }
  const options = [{ id: null, name: 'All domains', pending: false }, ...account.domains.map((d) => ({ id: d.id, name: d.name, pending: d.status !== 'verified' }))]

  return (
    <div className="domain-picker" ref={ref}>
      <button className="domain-picker-btn" title="Domain scope" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="ellipsis">{scope?.name ?? 'All domains'}</span>
        <Icon name="chevrons-up-down" size={12} />
      </button>
      {open && (
        <div className="domain-menu" role="menu">
          {options.map((o) => (
            <button key={o.id ?? 'all'} role="menuitemradio" aria-checked={(scope?.id ?? null) === o.id} onClick={() => pick(o.id)}>
              <span className="ellipsis">{o.name}</span>
              {o.pending && (
                <span className="pending" title="DNS records pending">
                  <Icon name="circle-alert" size={12} />
                </span>
              )}
              {(scope?.id ?? null) === o.id && <Icon name="check" size={14} />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
