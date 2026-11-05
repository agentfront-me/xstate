// Shared by the dashboard modules: API access, the session, theme, and the desktop bridge.
//
// The dashboard runs in two places: in the browser at xstate.com/app/, and inside the Electron app, which serves
// these same files from app://xstate/. In Electron, `window.xstateDesktop` (from apps/desktop/preload.cjs) adds
// the native bits: launch at login, menu bar, updates.

export const desktop = window.xstateDesktop ?? null

const LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname)
const API = desktop?.apiUrl ?? (LOCAL ? 'http://localhost:8788/v1' : 'https://api.xstate.com/v1')
const SESSION_KEY = 'xstate.session'
const THEME_KEY = 'theme'

// ---------------------------------------------------------------------------------------------------------------
// Storage

export function readJson(key) {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null')
  } catch {
    return null
  }
}

export function writeJson(key, value) {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Private mode or blocked storage: the dashboard still works, it just won't remember.
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Session and API

export function session() {
  const s = readJson(SESSION_KEY)
  return s && Date.parse(s.expiresAt) > Date.now() ? s : null
}

export function signOut() {
  writeJson(SESSION_KEY, null)
  writeJson('xstate.onboarding', null)
  location.assign('/login')
}

export class ApiError extends Error {
  constructor(code, message, status) {
    super(message)
    this.code = code
    this.status = status
  }
}

export async function api(method, path, body) {
  const token = session()?.token
  let res
  try {
    res = await fetch(API + path, {
      method,
      headers: {
        ...(token && { Authorization: `Bearer ${token}` }),
        ...(body && { 'Content-Type': 'application/json' }),
      },
      body: body && JSON.stringify(body),
    })
  } catch {
    throw new ApiError('network', "Couldn't reach xstate. Check your connection and try again.", 0)
  }
  if (res.status === 204) return undefined
  const data = await res.json().catch(() => ({}))
  if (res.ok) return data
  if (res.status === 401 && token) {
    signOut()
    throw new ApiError('signed_out', 'Your session ended. Sign in again.', 401)
  }
  throw new ApiError(data.error?.code ?? 'error', data.error?.message ?? 'Something went wrong. Try again.', res.status)
}

// ---------------------------------------------------------------------------------------------------------------
// Theme: 'light', 'dark' or 'system'. Stored under the same key the marketing site reads.

const systemDark = window.matchMedia('(prefers-color-scheme: dark)')

export function themeChoice() {
  try {
    const value = localStorage.getItem(THEME_KEY)
    return value === 'light' || value === 'dark' ? value : 'system'
  } catch {
    return 'system'
  }
}

export function applyTheme(choice = themeChoice()) {
  try {
    if (choice === 'system') localStorage.removeItem(THEME_KEY)
    else localStorage.setItem(THEME_KEY, choice)
  } catch {
    // Not remembered, still applied.
  }
  const dark = choice === 'dark' || (choice === 'system' && systemDark.matches)
  document.documentElement.classList.toggle('dark', dark)
  desktop?.setTheme(choice)
}

systemDark.addEventListener('change', () => {
  if (themeChoice() === 'system') applyTheme('system')
})

// ---------------------------------------------------------------------------------------------------------------
// Rendering helpers

export const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

export function initials(name) {
  const parts = String(name ?? '').trim().split(/[\s@.]+/).filter(Boolean)
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[1][0] : '')).toUpperCase() || '?'
}

export const isEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)

/** A small confirmation line at the bottom of the window. */
let toastTimer
export function toast(message) {
  let el = document.getElementById('toast')
  if (!el) {
    el = document.createElement('div')
    el.id = 'toast'
    el.className = 'toast'
    el.setAttribute('role', 'status')
    document.body.append(el)
  }
  el.textContent = message
  el.classList.add('is-on')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => el.classList.remove('is-on'), 2600)
}
