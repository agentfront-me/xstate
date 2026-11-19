// xstate's own analytics in the browser (docs/analytics-events.md): identify, reset and the two events that only
// happen in the browser. The snippet in each page's <head> defines window.xstate and loads xstate.js on
// xstate.com and go.xstate.com only, so on localhost and in the desktop app (app://xstate) calls just queue up and
// go nowhere. Page views and route changes are recorded by the snippet itself. Server events:
// apps/api/src/analytics/events.ts.

import type { Org, User } from './types'

type XstateFn = (...args: unknown[]) => void

declare global {
  interface Window {
    xstate?: XstateFn
  }
}

/** Every browser event and its properties. org_id is added to each. */
export type BrowserEvents = {
  'Checkout Started': { plan: 'pro' | 'team'; interval: 'month' | 'year'; seats: number }
  'Onboarding Completed': { domain_verified: boolean; agent_connected: boolean }
}

function call(...args: unknown[]): void {
  try {
    window.xstate?.(...args)
  } catch {
    // Analytics must never break the app.
  }
}

let orgId: string | null = null

/**
 * Ties this visitor to the signed-in user, on every page load with a session. `userHash` comes from the API
 * (auth/me, sign-up, sign-in); without it (no secret key on the server, e.g. local dev) nothing is sent.
 */
export function identify(user: User, org: Org, userHash: string | null | undefined): void {
  orgId = org.id
  if (!userHash) return
  call('identify', user.id, { email: user.email, name: user.name, org_id: org.id, role: org.role, plan: String(org.plan ?? 'free').toLowerCase() }, userHash)
}

/** On sign-out: forget the user, so the next person on this browser starts as a new visitor. */
export function reset(): void {
  orgId = null
  call('reset')
}

export function track<E extends keyof BrowserEvents>(event: E, properties: BrowserEvents[E]): void {
  call('track', event, { ...(orgId && { org_id: orgId }), ...properties })
}
