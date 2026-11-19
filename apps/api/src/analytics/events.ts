// xstate's own analytics: the server events of docs/analytics-events.md, sent to xstate Analytics itself
// (POST https://api.xstate.com/v1/collect with the main organization's secret key, XSTATE_SECRET_KEY).
//
// Every event name and its properties are declared once, here, so the code can't drift from the dictionary. The
// browser's events and identify() are in apps/app/src/lib/analytics.ts.
//
// Sending never slows a request down and never breaks one: track() hands the request to `background`
// (ctx.waitUntil, or a promise the caller awaits off the request path), and swallows every failure. Without
// XSTATE_SECRET_KEY (local dev, previews) nothing is sent.

const COLLECT_URL = 'https://api.xstate.com/v1/collect'
/** The site the events belong to. xstate.com and go.xstate.com are one site (audience/site.ts). */
const DOMAIN = 'xstate.com'

/** Any Worker env: the secret is optional, so it isn't in the generated Env type. */
type AnalyticsEnv = object
const secretOf = (env: AnalyticsEnv) => (env as { XSTATE_SECRET_KEY?: string }).XSTATE_SECRET_KEY

/** Where an action came from. HTTP calls name their app in the X-Client header; anything else is "app". */
export type Via = 'web' | 'mobile' | 'desktop' | 'app' | 'mcp' | 'agent'
type Role = 'owner' | 'admin' | 'member'
type PaidPlan = 'growth' | 'custom'
type Plan = 'free' | PaidPlan

/** Every server event and its properties (besides org_id, which every event carries). */
export type ServerEvents = {
  // Sign-up and onboarding
  'Signed Up': { source: 'signup' | 'invite'; role: Role }
  'Domain Added': { domain: string; is_first_domain: boolean; dns_provider: string | null }
  'Domain Verified': { domain: string; hours_to_verify: number }
  'Mailbox Created': { kind: 'personal' | 'shared' | 'agent'; is_first_mailbox: boolean }
  'Alias Added': Record<string, never>
  'Member Invited': { role: Role }
  'Invite Accepted': { role: Role; new_account: boolean }
  // Activation and use
  'Email Sent': { via: Via; is_reply: boolean; recipient_count: number; has_external_recipients: boolean; has_attachments: boolean }
  'Migration Started': { mailbox_count: number; includes: string[] }
  'Migration Completed': { mailbox_count: number; email_count: number; duration_hours: number }
  'AI App Connected': { client_name: string; scopes: string[] }
  'Agent Created': { provider: string | null }
  'API Token Created': { mailbox_count: number; expires: boolean }
  // Money. size: the Growth size in people (5,000 plus 100 per extra hundred) the organization pays for.
  'Order Completed': {
    revenue: number
    currency: string
    plan: PaidPlan | null
    size: number | null
    billing_reason: 'new' | 'renewal' | 'change' | 'other'
    transaction_id: string
  }
  'Plan Changed': { from_plan: Plan; to_plan: Plan; from_size: number | null; to_size: number | null; direction: 'upgrade' | 'downgrade' }
  'Payment Failed': { plan: Plan; size: number | null }
  'Order Refunded': { refund_amount: number; currency: string; transaction_id: string; full_refund: boolean }
  // Churn
  'Subscription Canceled': { plan: Plan; size: number | null; tenure_days: number; immediate: boolean }
  'Member Removed': { role: Role; tenure_days: number }
}
export type ServerEvent = keyof ServerEvents

export type Background = (promise: Promise<unknown>) => void

/**
 * Records `event` for `userId` (users.id, the same id identify() uses in the browser) in organization
 * `organizationId`. Returns at once; the request runs in `background`. `properties` may be a function when working
 * them out takes lookups: it runs in the background too, and if it throws the event is dropped.
 */
export function track<E extends ServerEvent>(
  env: AnalyticsEnv,
  background: Background,
  userId: string,
  organizationId: string,
  event: E,
  properties: ServerEvents[E] | (() => Promise<ServerEvents[E]>),
): void {
  const key = secretOf(env)
  if (!key) return
  background(
    (async () => {
      try {
        const props = typeof properties === 'function' ? await properties() : properties
        await send(key, { type: 'track', event, userId, domain: DOMAIN, properties: { org_id: organizationId, ...props } })
      } catch (err) {
        console.error('analytics: event dropped', event, err)
      }
    })(),
  )
}

async function send(key: string, body: { event: string; properties: Record<string, unknown> } & Record<string, unknown>): Promise<void> {
  try {
    const res = await fetch(COLLECT_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    })
    // The event and its properties (never personal data: see the dictionary) make a failure easy to trace.
    if (!res.ok) console.error('analytics: collect answered', res.status, body.event, JSON.stringify(body.properties), (await res.text()).slice(0, 200))
  } catch (err) {
    console.error('analytics: collect failed', body.event, err)
  }
}

/**
 * The hash identify() needs to attach a signed-in user to their visits: hex HMAC-SHA256 of the user id, keyed with
 * XSTATE_SECRET_KEY. null without the key, and the app then skips identify().
 */
export async function userHash(env: AnalyticsEnv, userId: string): Promise<string | null> {
  const secret = secretOf(env)
  if (!secret) return null
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(String(userId))))
  return Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** No-op background, for callers that don't record events. */
export const noBackground: Background = () => {}

/** Whole days between an ISO time and now. */
export function daysSince(iso: string | null | undefined): number {
  return iso ? Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 86_400_000)) : 0
}

/** For callers with no ctx.waitUntil (queue consumers, workflows): collect the sends, then await them. */
export function collector(): { background: Background; flush: () => Promise<void> } {
  const pending: Promise<unknown>[] = []
  return { background: (p) => void pending.push(p), flush: async () => void (await Promise.allSettled(pending)) }
}
