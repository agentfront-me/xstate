// Shared by the dashboard and the sign-in pages: API access, the session, theme, storage and the desktop bridge.
//
// The dashboard runs in two places: in the browser at go.xstate.com/app/, and inside the Electron app, which serves
// the same build from app://xstate/. In Electron, `window.xstateDesktop` (apps/desktop/preload.cjs) adds the
// native bits: launch at login, menu bar, updates.

import { reset as resetAnalytics } from './analytics'

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
/** The marketing site and docs (apps/web). The app itself lives on go.xstate.com. */
export const SITE_URL = LOCAL ? 'http://localhost:8785' : 'https://xstate.com'
/** The address people give their AI app to connect it to xstate (the API serves it locally, apps/api/src/mcp/oauth.ts). */
export const MCP_URL = !desktop?.apiUrl && LOCAL ? `${new URL(DEV_API).origin}/mcp` : 'https://mcp.xstate.com/mcp'
/** Where the app is served on the web; links made inside the desktop app point here. */
export const APP_ORIGIN = 'https://go.xstate.com'
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

/**
 * Sets (or, with null, deletes) a cookie that xstate.com and go.xstate.com both read: on .xstate.com in production,
 * host-only in development (cookies ignore the port, so the localhost dev servers share it). Script-readable, so
 * it must never hold anything secret.
 */
export function setSiteCookie(name: string, value: string | null, maxAgeSeconds: number): void {
  const domain = /(^|\.)xstate\.com$/.test(location.hostname) ? '; domain=xstate.com' : ''
  const secure = location.protocol === 'https:' ? '; secure' : ''
  const pair = value === null ? `${name}=; max-age=0` : `${name}=${value}; max-age=${Math.max(0, Math.floor(maxAgeSeconds))}`
  document.cookie = `${pair}; path=/; samesite=lax${domain}${secure}`
}

// ---------------------------------------------------------------------------------------------------------------
// Session and API
//
// The session token stays in this origin's localStorage and goes to the API as a Bearer header. The marketing site
// only gets a `signed_in=1` hint cookie (no token, nothing secret) so it can offer "Open app" instead of "Log in".
// It expires with the session. The desktop app (app://) has no cookies and no need for the hint.

function setSignedInHint(s: Session | null): void {
  if (desktop) return
  const seconds = s ? (Date.parse(s.expiresAt) - Date.now()) / 1000 : 0
  setSiteCookie('signed_in', seconds > 0 ? '1' : null, seconds)
}

export type Session = { token: string; expiresAt: string }

export function session(): Session | null {
  const s = readJson<Session>(SESSION_KEY)
  return s && Date.parse(s.expiresAt) > Date.now() ? s : null
}

export function saveSession(s: Session): void {
  writeJson(SESSION_KEY, { token: s.token, expiresAt: s.expiresAt })
  setSignedInHint(s)
}

export function signOut(): void {
  resetAnalytics()
  writeJson(SESSION_KEY, null)
  setSignedInHint(null)
  writeJson(PROGRESS_KEY, null)
  location.assign('/login')
}

// Keep the hint in step on every page load: it covers sessions saved before the hint existed, and a token cleared
// from storage some other way.
setSignedInHint(session())

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    /** Structured data some errors carry, such as the DNS record to add. */
    readonly details?: Record<string, unknown>,
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

/**
 * Like apiBlob, plus the warning an attachment download carries (X-Attachment-Warning: macros,
 * encrypted_archive, unchecked_archive), or null.
 */
export async function apiDownload(path: string): Promise<{ blob: Blob; warning: string | null }> {
  const res = await request('GET', path)
  return { blob: await res.blob(), warning: res.headers.get('X-Attachment-Warning') }
}

async function request(method: string, path: string, body?: unknown, { file, anonymous }: ApiOptions = {}): Promise<Response> {
  const token = anonymous ? undefined : session()?.token
  let res: Response
  try {
    res = await fetch(API + path, {
      method,
      headers: {
        ...(token && { Authorization: `Bearer ${token}` }),
        // Which app made the call, for xstate's own analytics ("Email Sent" via web or desktop).
        'X-Client': desktop ? 'desktop' : 'web',
        ...(body !== undefined && { 'Content-Type': 'application/json' }),
        ...(file && { 'Content-Type': file.type || 'application/octet-stream' }),
      },
      body: file ?? (body === undefined ? undefined : JSON.stringify(body)),
    })
  } catch {
    throw new ApiError('network', "Couldn't reach xstate. Check your connection and try again.", 0)
  }
  if (res.ok) return res
  const data = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string; details?: Record<string, unknown> } }
  if (res.status === 401 && token) {
    signOut()
    throw new ApiError('signed_out', 'Your session ended. Sign in again.', 401)
  }
  throw new ApiError(data.error?.code ?? 'error', data.error?.message ?? 'Something went wrong. Try again.', res.status, data.error?.details)
}

export const errorMessage = (err: unknown) => (err instanceof Error ? err.message : 'Something went wrong. Try again.')

// ---------------------------------------------------------------------------------------------------------------
// Theme: 'light', 'dark' or 'system' (no stored value).
//
// On the web the choice lives in a `theme` cookie on .xstate.com, so xstate.com and go.xstate.com share it (the
// marketing site copies it into next-themes, see apps/web/app/layout.tsx). localStorage is per origin and can't be
// shared. The desktop app runs from app://, which has no cookies, so it keeps using localStorage. Each page's
// inline <script> in its index.html reads the same cookie, falling back to localStorage, before first paint.

export type ThemeChoice = 'light' | 'dark' | 'system'
const systemDark = window.matchMedia('(prefers-color-scheme: dark)')
const useCookie = !desktop

function readThemeCookie(): string | null {
  return document.cookie.match(/(?:^|; )theme=(light|dark)(?:;|$)/)?.[1] ?? null
}

function writeThemeCookie(choice: ThemeChoice): void {
  setSiteCookie(THEME_KEY, choice === 'system' ? null : choice, 31536000)
}

// A choice saved in localStorage before the cookie existed moves to the cookie once, and the localStorage copy
// goes away so it can't override a later change made on the other site.
if (useCookie) {
  try {
    const old = localStorage.getItem(THEME_KEY)
    if ((old === 'light' || old === 'dark') && !readThemeCookie()) writeThemeCookie(old)
    localStorage.removeItem(THEME_KEY)
  } catch {
    // Nothing to move.
  }
}

export function themeChoice(): ThemeChoice {
  try {
    const value = useCookie ? readThemeCookie() : localStorage.getItem(THEME_KEY)
    return value === 'light' || value === 'dark' ? value : 'system'
  } catch {
    return 'system'
  }
}

export function applyTheme(choice: ThemeChoice = themeChoice()): void {
  try {
    if (useCookie) writeThemeCookie(choice)
    else if (choice === 'system') localStorage.removeItem(THEME_KEY)
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
