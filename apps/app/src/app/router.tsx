// Routes are hash-based (#/mail, #/settings/domains) so the same build works at go.xstate.com/app/ and from the
// desktop app's app:// origin, where there's no server to answer deep links.

import { createHashHistory, createRootRoute, createRoute, createRouter, Navigate } from '@tanstack/react-router'
import { lazy, Suspense } from 'react'
import { type AgentsSearch, AgentsPage } from '../agents/AgentsPage'
import { MailPage } from '../mail/MailPage'
import { SettingsPage } from '../settings/SettingsPage'
import { type StorageSearch, type StorageView, StoragePage } from '../storage/StoragePage'
import { type UsersSearch, UsersPage } from '../users/UsersPage'
import { Shell } from './Shell'
import { PAGES, SoonPage } from './pages'

const root = createRootRoute({ component: Shell })

const index = createRoute({ getParentRoute: () => root, path: '/', component: () => <Navigate to="/mail" replace /> })

const mail = createRoute({ getParentRoute: () => root, path: '/mail', component: MailPage })

const VIEWS: StorageView[] = ['personal', 'organization', 'shared', 'trash', 'attachments']
const str = (v: unknown) => (typeof v === 'string' && v.length > 0 && v.length <= 64 ? v : undefined)

const storage = createRoute({
  getParentRoute: () => root,
  path: '/storage',
  validateSearch: (raw: Record<string, unknown>): StorageSearch => ({
    view: VIEWS.includes(raw.view as StorageView) ? (raw.view as StorageView) : undefined,
    folder: str(raw.folder),
    mailbox: str(raw.mailbox),
    source: raw.source === 'received' || raw.source === 'sent' ? raw.source : undefined,
    open: str(raw.open),
    att: str(raw.att),
    q: typeof raw.q === 'string' && raw.q.trim() ? raw.q.slice(0, 500) : undefined,
  }),
  component: function Storage() {
    return <StoragePage search={storage.useSearch()} />
  },
})

const users = createRoute({
  getParentRoute: () => root,
  path: '/users',
  validateSearch: (raw: Record<string, unknown>): UsersSearch => ({
    segment: str(raw.segment),
    domain: typeof raw.domain === 'string' && raw.domain && raw.domain.length <= 253 ? raw.domain : undefined,
    q: typeof raw.q === 'string' && raw.q.trim() ? raw.q.slice(0, 200) : undefined,
    person: str(raw.person),
  }),
  component: function Users() {
    return <UsersPage search={users.useSearch()} />
  },
})

// FullCalendar is large (about 70 KB gzipped), so the Calendar page loads the first time it's opened.
const CalendarPage = lazy(() => import('../calendar/CalendarPage').then((m) => ({ default: m.CalendarPage })))

export type CalendarSearch = { date?: string; event?: string }

const calendar = createRoute({
  getParentRoute: () => root,
  path: '/calendar',
  // ?date=YYYY-MM-DD&event=<id>: open the grid on that day with that event (links from invitation emails).
  validateSearch: (raw: Record<string, unknown>): CalendarSearch => ({
    date: typeof raw.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.date) ? raw.date : undefined,
    event: typeof raw.event === 'string' && raw.event.length <= 128 ? raw.event : undefined,
  }),
  component: function Calendar() {
    const search = calendar.useSearch()
    return (
      <Suspense fallback={<div className="loading" style={{ flex: 1 }}><span className="spinner" /></div>}>
        <CalendarPage search={search} />
      </Suspense>
    )
  },
})

const agents = createRoute({
  getParentRoute: () => root,
  path: '/agents',
  validateSearch: (raw: Record<string, unknown>): AgentsSearch => ({
    agent: str(raw.agent),
    tab: raw.tab === 'runs' || raw.tab === 'setup' || raw.tab === 'approvals' || raw.tab === 'settings' ? raw.tab : undefined,
    run: str(raw.run),
  }),
  component: function Agents() {
    return <AgentsPage search={agents.useSearch()} />
  },
})

const settingsIndex = createRoute({
  getParentRoute: () => root,
  path: '/settings',
  component: () => <Navigate to="/settings/$section" params={{ section: 'account' }} replace />,
})

const settings = createRoute({
  getParentRoute: () => root,
  path: '/settings/$section',
  component: function Settings() {
    const { section } = settings.useParams()
    return <SettingsPage section={section} />
  },
})

/** Pages not built yet show "coming soon". Anything else, including hidden pages, goes to Email. */
const soon = createRoute({
  getParentRoute: () => root,
  path: '/$page',
  component: function Soon() {
    const { page } = soon.useParams()
    const p = PAGES.find((x) => x.id === page && x.id !== 'mail')
    return p ? <SoonPage page={p} /> : <Navigate to="/mail" replace />
  },
})

export const router = createRouter({
  routeTree: root.addChildren([index, mail, storage, users, agents, calendar, settingsIndex, settings, soon]),
  history: createHashHistory(),
  defaultNotFoundComponent: () => <Navigate to="/mail" replace />,
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
