// Dashboard shell: the rail, routing and theme. Pages render into #main.
//
// Routes (hash, so the same files work at xstate.com/app/ and from the desktop app's app:// origin):
//   #/mail                     Email
//   #/settings/<section>       Settings: account, members, domains, secrets, billing, integrations
//   #/storage, #/databases, #/agents, #/sites   Not built yet

import { applyTheme, desktop, esc, initials, signOut, themeChoice } from './core.js'
import { icon } from './icons.js'
import { renderMail, unreadCount } from './mail.js'
import { renderSettings } from './settings.js'
import { load, onChange, store } from './store.js'

const rail = document.getElementById('rail')
const main = document.getElementById('main')

const PAGES = [
  { id: 'mail', label: 'Email', icon: 'inbox' },
  { id: 'storage', label: 'Storage', icon: 'hard-drive' },
  { id: 'databases', label: 'Databases', icon: 'database' },
  { id: 'agents', label: 'Agents', icon: 'bot' },
  { id: 'sites', label: 'Sites', icon: 'globe' },
]

const COLLAPSED_KEY = 'xstate.rail-collapsed'

// In the desktop app the window has no title bar: macOS traffic lights sit over the rail, and on Windows and Linux
// the window controls overlay the top right corner.
if (desktop) document.documentElement.classList.add(desktop.platform === 'darwin' ? 'is-mac' : 'has-overlay')

// ---------------------------------------------------------------------------------------------------------------
// Routing. Back and forward walk the browser history; history.state.i tells us where we are in it.

function route() {
  const [page = 'mail', section] = location.hash.replace(/^#\/?/, '').split('/')
  return { page, section }
}

let historyIndex = history.state?.i ?? 0
let historyMax = historyIndex

export function navigate(hash) {
  if (location.hash === hash) return
  historyIndex += 1
  historyMax = historyIndex
  history.pushState({ i: historyIndex }, '', hash)
  render()
}

window.addEventListener('popstate', (event) => {
  historyIndex = event.state?.i ?? 0
  render()
})

// ---------------------------------------------------------------------------------------------------------------
// Rail

function collapsed() {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}

function renderRail() {
  const { page } = route()
  const theme = document.documentElement.classList.contains('dark') ? 'dark' : 'light'
  const unread = unreadCount()
  desktop?.setUnread(unread)
  rail.classList.toggle('is-collapsed', collapsed())
  rail.innerHTML = `
    <div class="rail-top drag">
      <button class="ghost" data-act="collapse" title="Toggle sidebar" aria-label="Toggle sidebar">${icon('panel-left', 16)}</button>
      <span class="history" style="display:flex;gap:2px">
        <button class="ghost" data-act="back" aria-label="Back" ${historyIndex > 0 ? '' : 'disabled'}>${icon('chevron-left', 16)}</button>
        <button class="ghost" data-act="forward" aria-label="Forward" ${historyIndex < historyMax ? '' : 'disabled'}>${icon('chevron-right', 16)}</button>
      </span>
      <span class="spacer"></span>
      <div class="seg icons" role="group" aria-label="Theme">
        <button data-theme="light" aria-pressed="${theme === 'light'}" aria-label="Light">${icon('sun', 14)}</button>
        <button data-theme="dark" aria-pressed="${theme === 'dark'}" aria-label="Dark">${icon('moon', 14)}</button>
      </div>
    </div>
    <nav class="nav">
      <button class="nav-item" data-act="search" title="Search">
        ${icon('search', 16)}<span class="label">Search</span><kbd>${desktop?.platform === 'darwin' || /Mac/.test(navigator.platform) ? '⌘K' : 'Ctrl K'}</kbd>
      </button>
      ${PAGES.map(
        (p) => `
        <button class="nav-item" data-page="${p.id}" title="${p.label}" ${page === p.id ? 'aria-current="page"' : ''}>
          ${icon(p.icon, 16)}<span class="label">${p.label}</span>
          ${p.id === 'mail' && unread ? `<span class="count">${unread}</span>` : ''}
        </button>`,
      ).join('')}
    </nav>
    <div class="rail-foot">
      <button class="me" data-act="settings" title="Settings" ${page === 'settings' ? 'aria-current="page"' : ''}>
        <span class="avatar">${esc(initials(store.user?.name || store.user?.email)[0])}</span>
        <span class="ellipsis"><span class="name">${esc(store.user?.name || store.user?.email || '')}</span>
        <span class="muted"> · ${esc(store.org?.plan ?? 'Free')}</span></span>
        ${icon('chevron-down', 13)}
      </button>
    </div>`
}

rail.addEventListener('click', (event) => {
  const el = event.target.closest('button')
  if (!el) return
  if (el.dataset.page) return navigate(`#/${el.dataset.page}`)
  if (el.dataset.theme) {
    applyTheme(el.dataset.theme)
    return render()
  }
  switch (el.dataset.act) {
    case 'collapse':
      try {
        localStorage.setItem(COLLAPSED_KEY, collapsed() ? '0' : '1')
      } catch {}
      return renderRail()
    case 'back':
      return history.back()
    case 'forward':
      return history.forward()
    case 'settings':
      return navigate('#/settings/account')
    case 'search':
      return openSearch()
  }
})

function openSearch() {
  if (route().page !== 'mail') navigate('#/mail')
  window.dispatchEvent(new CustomEvent('xstate:search'))
}

document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault()
    openSearch()
  }
})

// ---------------------------------------------------------------------------------------------------------------
// Pages

function renderSoon(page) {
  const p = PAGES.find((x) => x.id === page)
  main.innerHTML = `
    <section class="soon">
      <div class="col-head drag"><span class="title">${p.label}</span></div>
      <div class="empty">${icon(p.icon, 28)}<strong>${p.label} is coming soon</strong><span>Email and Settings are ready to use today.</span></div>
    </section>`
}

function render() {
  renderRail()
  const { page, section } = route()
  if (page === 'settings') return renderSettings(main, section ?? 'account', { navigate, refreshRail: renderRail })
  if (PAGES.some((p) => p.id === page && p.id !== 'mail')) return renderSoon(page)
  return renderMail(main, { navigate, refreshRail: renderRail })
}

onChange(render)

// The desktop app's menu (Settings…, New mail) and tray send these.
desktop?.onCommand?.((command) => {
  if (command === 'settings') navigate('#/settings/account')
  if (command === 'new-mail') {
    navigate('#/mail')
    window.dispatchEvent(new CustomEvent('xstate:compose'))
  }
})

async function start() {
  applyTheme(themeChoice())
  try {
    if (!(await load())) return location.assign('/login')
  } catch (err) {
    if (err.code === 'signed_out') return
    main.innerHTML = `
      <div class="empty">${icon('circle-alert', 24)}<strong>Couldn't load your account</strong><span>${esc(err.message)}</span>
        <span style="display:flex;gap:8px;margin-top:8px"><button class="btn" id="retry">Try again</button><button class="btn btn-quiet" id="out">Sign out</button></span></div>`
    main.querySelector('#retry').addEventListener('click', start)
    main.querySelector('#out').addEventListener('click', signOut)
    return
  }
  if (!history.state) history.replaceState({ i: 0 }, '', location.hash || '#/mail')
  render()
}

start()
