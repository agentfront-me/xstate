// Dashboard shell: the rail on the left and the current page. Also wires ⌘K, the desktop app's menu commands
// and the unread badge.

import { Outlet, useNavigate, useRouter, useRouterState } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { Icon } from '../components/Icon'
import { useAccount } from '../lib/account'
import { applyTheme, desktop, initials, isMac } from '../lib/core'
import { useIsDark } from '../lib/theme'
import { MailSync, useUnreadCount } from '../mail/data'
import { requestMail } from '../mail/intents'
import { PAGES } from './pages'

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
  const dark = useIsDark()
  const unread = useUnreadCount()
  const history = useHistoryButtons()
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSED_KEY) === '1'
    } catch {
      return false
    }
  })

  useEffect(() => {
    desktop?.setUnread(unread)
  }, [unread])

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
        <span className="spacer" />
        <div className="seg icons" role="group" aria-label="Theme">
          <button aria-pressed={!dark} aria-label="Light" onClick={() => applyTheme('light')}>
            <Icon name="sun" size={14} />
          </button>
          <button aria-pressed={dark} aria-label="Dark" onClick={() => applyTheme('dark')}>
            <Icon name="moon" size={14} />
          </button>
        </div>
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
            onClick={() => void navigate({ to: p.id === 'mail' ? '/mail' : '/$page', params: { page: p.id } })}
          >
            <Icon name={p.icon} size={16} />
            <span className="label">{p.label}</span>
            {p.id === 'mail' && unread > 0 && <span className="count">{unread}</span>}
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
          <span className="ellipsis">
            <span className="name">{name}</span>
            <span className="muted"> · {account.org.plan ?? 'Free'}</span>
          </span>
          <Icon name="chevron-down" size={13} />
        </button>
      </div>
    </aside>
  )
}
