// Routes are hash-based (#/mail, #/settings/domains) so the same build works at xstate.com/app/ and from the
// desktop app's app:// origin, where there's no server to answer deep links.

import { createHashHistory, createRootRoute, createRoute, createRouter, Navigate } from '@tanstack/react-router'
import { MailPage } from '../mail/MailPage'
import { SettingsPage } from '../settings/SettingsPage'
import { type StorageSearch, type StorageView, StoragePage } from '../storage/StoragePage'
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
  }),
  component: function Storage() {
    return <StoragePage search={storage.useSearch()} />
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

/** Databases, Agents and Sites: not built yet. Anything else goes to Email. */
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
  routeTree: root.addChildren([index, mail, storage, settingsIndex, settings, soon]),
  history: createHashHistory(),
  defaultNotFoundComponent: () => <Navigate to="/mail" replace />,
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
