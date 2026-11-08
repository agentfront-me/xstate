// Shared by the dashboard and the sign-in pages: API access, the session, theme, storage and the desktop bridge.
//
// The dashboard runs in two places: in the browser at xstate.com/app/, and inside the Electron app, which serves
// the same build from app://xstate/. In Electron, `window.xstateDesktop` (apps/desktop/preload.cjs) adds the
// native bits: launch at login, menu bar, updates.

export type DesktopSettings = Record<string, boolean>
export type DesktopBridge = {
  platform: string
  platformName: string
  version: string
  apiUrl?: string
  getSettings(): Promise<DesktopSettings>
  setSetting(key: string, value: boolean): Promise<void>
  checkForUpdates(): Promise<string>
  setTheme(choice: ThemeChoice): void
  setUnread(count: number): void
  onCommand?(fn: (command: string) => void): void
}

declare global {
  interface Window {
    xstateDesktop?: DesktopBridge
  }
}

export const desktop: DesktopBridge | null = window.xstateDesktop ?? null
export const isMac = desktop ? desktop.platform === 'darwin' : /Mac/.test(navigator.platform)

const LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname)
// Dev only: VITE_API_URL points the dashboard at another local API (e.g. a second wrangler dev on its own port).
const DEV_API = (import.meta.env.VITE_API_URL as string | undefined) || 'http://localhost:8788/v1'
const API = desktop?.apiUrl ?? (LOCAL ? DEV_API : 'https://api.xstate.com/v1')
const SESSION_KEY = 'xstate.session'
export const PROGRESS_KEY = 'xstate.onboarding'
const THEME_KEY = 'theme'

// ---------------------------------------------------------------------------------------------------------------
// Storage

export function readJson<T>(key: string): T | null {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null') as T | null
  } catch {
    return null
  }
}

export function writeJson(key: string, value: unknown): void {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Private mode or blocked storage: everything still works, it just won't be remembered.
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Session and API

export type Session = { token: string; expiresAt: string }

export function session(): Session | null {
  const s = readJson<Session>(SESSION_KEY)
  return s && Date.parse(s.expiresAt) > Date.now() ? s : null
}

export function saveSession(s: Session): void {
  writeJson(SESSION_KEY, { token: s.token, expiresAt: s.expiresAt })
}

export function signOut(): void {
  writeJson(SESSION_KEY, null)
  writeJson(PROGRESS_KEY, null)
  location.assign('/login')
}

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

/** `anonymous` leaves the session off, for public pages that shouldn't send it. */
type ApiOptions = { file?: File; anonymous?: boolean }

/** The full URL of an API path, for links the browser follows itself (downloads). */
export const apiUrl = (path: string) => API + path

/** Calls the API and returns its JSON. `file` sends the file itself as the body (attachment uploads). */
export async function api<T = unknown>(method: string, path: string, body?: unknown, options: ApiOptions = {}): Promise<T> {
  const res = await request(method, path, body, options)
  if (res.status === 204) return undefined as T
  return (await res.json().catch(() => ({}))) as T
}

/** Calls the API and returns the response body as a Blob (downloads). */
export async function apiBlob(path: string, options: ApiOptions = {}): Promise<Blob> {
  return (await request('GET', path, undefined, options)).blob()
}

async function request(method: string, path: string, body?: unknown, { file, anonymous }: ApiOptions = {}): Promise<Response> {
  const token = anonymous ? undefined : session()?.token
  let res: Response
  try {
    res = await fetch(API + path, {
      method,
      headers: {
        ...(token && { Authorization: `Bearer ${token}` }),
        ...(body !== undefined && { 'Content-Type': 'application/json' }),
        ...(file && { 'Content-Type': file.type || 'application/octet-stream' }),
      },
      body: file ?? (body === undefined ? undefined : JSON.stringify(body)),
    })
  } catch {
    throw new ApiError('network', "Couldn't reach xstate. Check your connection and try again.", 0)
  }
  if (res.ok) return res
  const data = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } }
  if (res.status === 401 && token) {
    signOut()
    throw new ApiError('signed_out', 'Your session ended. Sign in again.', 401)
  }
  throw new ApiError(data.error?.code ?? 'error', data.error?.message ?? 'Something went wrong. Try again.', res.status)
}

export const errorMessage = (err: unknown) => (err instanceof Error ? err.message : 'Something went wrong. Try again.')

// ---------------------------------------------------------------------------------------------------------------
// Theme: 'light', 'dark' or 'system'. Stored under the same key the marketing site reads.

export type ThemeChoice = 'light' | 'dark' | 'system'
const systemDark = window.matchMedia('(prefers-color-scheme: dark)')

export function themeChoice(): ThemeChoice {
  try {
    const value = localStorage.getItem(THEME_KEY)
    return value === 'light' || value === 'dark' ? value : 'system'
  } catch {
    return 'system'
  }
}

export function applyTheme(choice: ThemeChoice = themeChoice()): void {
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
// Small helpers

export function initials(name: string | null | undefined): string {
  const parts = String(name ?? '').trim().split(/[\s@.]+/).filter(Boolean)
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[1]![0] : '')).toUpperCase() || '?'
}

export const isEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)

export const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

/** Copies text, falling back to a hidden textarea where the Clipboard API is blocked. Returns whether it worked. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const area = Object.assign(document.createElement('textarea'), { value: text, readOnly: true })
    area.style.cssText = 'position:fixed;opacity:0;pointer-events:none'
    document.body.append(area)
    area.select()
    const ok = document.execCommand('copy')
    area.remove()
    return ok
  }
}
