// The Analytics API (analytics_* operations in apps/api/src/operations/audience.ts): the live event feed, one
// event in full, the test event and settings. Events come from the snippet and POST /v1/collect.

import { api, apiUrl } from '../lib/core'
import type { PersonKind } from '../users/api'

export type EventType = 'page' | 'track' | 'identify' | 'email'

export type FeedEvent = {
  id: number
  type: EventType
  name: string
  properties: Record<string, unknown>
  url: string | null
  path: string | null
  domain: string | null
  sessionId: string | null
  occurredAt: string
  person: { id: string; kind: PersonKind; name: string | null; email: string | null; externalId: string | null; anonymousId: string | null }
}

/** The visit an event belongs to: the columns of the sessions table that were recorded (snake_case). */
export type Visit = Record<string, string | number>

export type AnalyticsSettings = { storeIp: boolean }

export type AnalyticsStatus = { lastEventAt: string | null; publishableKey: string; settings: AnalyticsSettings; canManage: boolean }

export type EventsPage = { events: FeedEvent[]; recent: number; nextBefore: number | null }

export type EventQuery = { domain?: string; type?: EventType; q?: string; before?: number; after?: number; limit?: number }

export type FunnelStep = { type: 'page' | 'track' | 'email'; match: string }
export type FunnelInput = { name: string; steps: FunnelStep[]; windowDays: number }
export type Funnel = FunnelInput & { id: string; createdAt: string; updatedAt: string }
export type FunnelRange = 7 | 30 | 90
export type FunnelResult = {
  steps: { people: number; fromPrevious: number | null; dropped: number | null; medianSeconds: number | null }[]
  conversion: number
  range: FunnelRange
  computedAt: string
}

const qs = (params: Record<string, string | number | undefined>) => {
  const s = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') s.set(k, String(v))
  const out = s.toString()
  return out ? `?${out}` : ''
}

export const analyticsKeys = { all: ['analytics'] as const }

export const analyticsApi = {
  status: (org: string, domain?: string) => api<AnalyticsStatus>('GET', `/analytics/orgs/${org}/status${qs({ domain })}`),
  events: (org: string, q: EventQuery) => api<EventsPage>('GET', `/analytics/orgs/${org}/events${qs(q)}`),
  event: (org: string, id: number) => api<{ event: FeedEvent; visit: Visit | null }>('GET', `/analytics/orgs/${org}/events/${id}`),
  testEvent: (org: string, domain: string) => api<{ accepted: number }>('POST', `/analytics/orgs/${org}/test-event`, { domain }),
  updateSettings: (org: string, patch: Partial<AnalyticsSettings>) =>
    api<{ settings: AnalyticsSettings }>('PATCH', `/analytics/orgs/${org}/settings`, patch),
  funnels: (org: string, domain?: string) => api<{ funnels: (Funnel & { conversion: number })[]; canManage: boolean }>('GET', `/analytics/orgs/${org}/funnels${qs({ domain })}`),
  funnelResult: (org: string, id: string, range: FunnelRange, domain?: string) =>
    api<{ funnel: Funnel; result: FunnelResult }>('GET', `/analytics/orgs/${org}/funnels/${id}/result${qs({ range, domain })}`),
  funnelOptions: (org: string) => api<{ events: string[]; paths: string[] }>('GET', `/analytics/orgs/${org}/funnel-options`),
  createFunnel: (org: string, input: FunnelInput) => api<{ funnel: Funnel }>('POST', `/analytics/orgs/${org}/funnels`, input),
  updateFunnel: (org: string, id: string, input: FunnelInput) => api<{ funnel: Funnel }>('PUT', `/analytics/orgs/${org}/funnels/${id}`, input),
  deleteFunnel: (org: string, id: string) => api('DELETE', `/analytics/orgs/${org}/funnels/${id}`),
}

export const EMAIL_STEPS: { name: string; label: string }[] = [
  { name: '$email_received', label: 'Email received' },
  { name: '$email_replied', label: 'Email replied' },
  { name: '$email_sent', label: 'Email sent' },
  { name: '$email_bounced', label: 'Email bounced' },
  { name: '$email_complained', label: 'Marked as spam' },
]

/** "Viewed /products/*", "Added to Cart", "Email received". */
export function stepLabel(step: FunnelStep): string {
  if (step.type === 'page') return `Viewed ${step.match}`
  if (step.type === 'email') return EMAIL_STEPS.find((e) => e.name === step.match)?.label ?? step.match
  return step.match
}

export const STEP_KIND: Record<FunnelStep['type'], string> = { page: 'Page', track: 'Track', email: 'Email' }

/** "4 min", "2 h", "3 d". */
export function duration(seconds: number | null): string {
  if (seconds === null) return '—'
  if (seconds < 60) return `${Math.round(seconds)} s`
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`
  if (seconds < 86_400) return `${Math.round(seconds / 360) / 10} h`
  return `${Math.round(seconds / 8640) / 10} d`
}

export const percent = (x: number) => `${(Math.round(x * 1000) / 10).toFixed(1)}%`

/** Where the snippet loads from and events go: the API this dashboard talks to. */
export const API_ORIGIN = apiUrl('').replace(/\/v1$/, '')

// ---------------------------------------------------------------------------------------------------------------
// Display helpers

export const TYPE_LABEL: Record<EventType, string> = { page: 'Page', track: 'Track', identify: 'Identify', email: 'Email' }

/** Email events xstate records from the organization's mailboxes (api audience/email.ts). */
const EMAIL_LABEL: Record<string, string> = {
  $email_received: 'Email received',
  $email_replied: 'Email replied',
  $email_sent: 'Email sent',
  $email_bounced: 'Email bounced',
  $email_complained: 'Marked as spam',
}
/** Properties of email events that are ids, not worth showing. */
const HIDDEN_PROPS = new Set(['mailbox_id', 'email_id', 'address'])

/** What the Event column says: the page's path, "Identify", the email activity, or the event's name. */
export function eventLabel(e: FeedEvent): string {
  if (e.type === 'page') return e.path ?? pathOf(e.url) ?? 'Page view'
  if (e.type === 'identify') return 'Identify'
  if (e.type === 'email') return EMAIL_LABEL[e.name] ?? e.name
  if (e.name === '$outbound_click') return `Outbound click${typeof e.properties.domain === 'string' ? ` · ${e.properties.domain}` : ''}`
  return e.name
}

function pathOf(url: string | null): string | null {
  if (!url) return null
  try {
    return new URL(url).pathname
  } catch {
    return null
  }
}

/** Who did it: their email, name or user id, else the short visitor id. */
export function whoLabel(p: FeedEvent['person']): { text: string; anonymous: boolean } {
  const known = p.email ?? p.name ?? (p.externalId ? `User ${p.externalId}` : null)
  if (known) return { text: known, anonymous: false }
  return { text: (p.anonymousId ?? p.id).slice(0, 12), anonymous: true }
}

/** "path: /cart · title: Cart · referrer: (direct)", as the design's Properties column. */
export function propertiesLine(e: FeedEvent): string {
  return Object.entries(e.properties)
    .filter(([k, v]) => v !== undefined && v !== null && v !== '' && !(e.type === 'email' && HIDDEN_PROPS.has(k)))
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join(' · ')
}

export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

/**
 * The event as the side panel shows it: the shape a developer would send (type, name, ids, properties), with the
 * context xstate added from the visit (page, location, device, campaign).
 */
export function eventJson(e: FeedEvent, visit: Visit | null): Record<string, unknown> {
  const v = visit ?? {}
  const pick = (keys: [string, string][]) => {
    const out: Record<string, unknown> = {}
    for (const [from, to] of keys) if (v[from] !== undefined) out[to] = v[from]
    return Object.keys(out).length ? out : undefined
  }
  const context: Record<string, unknown> = {
    library: v.library,
    page: e.path || e.url ? { path: e.path ?? undefined, url: e.url ?? undefined } : undefined,
    ip: v.ip,
    locale: v.locale,
    location: pick([['country', 'country'], ['region', 'region'], ['city', 'city'], ['postal_code', 'postalCode'], ['timezone', 'timezone'], ['latitude', 'latitude'], ['longitude', 'longitude']]),
    network: pick([['as_org', 'organization'], ['asn', 'asn']]),
    device: pick([['browser', 'browser'], ['browser_version', 'browserVersion'], ['os', 'os'], ['os_version', 'osVersion'], ['device_type', 'type'], ['screen', 'screen'], ['viewport', 'viewport']]),
    campaign: pick([['utm_source', 'source'], ['utm_medium', 'medium'], ['utm_campaign', 'name'], ['utm_term', 'term'], ['utm_content', 'content'], ['click_id', 'clickId']]),
    referrer: v.referrer,
    channel: v.channel,
    session: e.sessionId ? { id: e.sessionId, startedAt: v.started_at, landingPage: v.landing_path } : undefined,
  }
  for (const k of Object.keys(context)) if (context[k] === undefined) delete context[k]
  const json: Record<string, unknown> = { type: e.type, name: e.type === 'page' ? undefined : e.name }
  if (e.person.externalId) json.userId = e.person.externalId
  if (e.person.anonymousId) json.anonymousId = e.person.anonymousId
  json[e.type === 'identify' ? 'traits' : 'properties'] = e.properties
  if (Object.keys(context).length) json.context = context
  json.timestamp = e.occurredAt
  if (json.name === undefined) delete json.name
  return json
}
