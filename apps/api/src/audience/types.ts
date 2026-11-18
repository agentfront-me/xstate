// Audience: the people who visit or use an organization's websites, their events, and saved segments of them.
// Shapes shared by the operations (operations/audience.ts), the public collect endpoint (collect.ts) and the
// per-organization Durable Object that stores everything (store.ts).

import { z } from 'zod'
import type { Campaign, Channel, ClickId } from './channel'

/** Raw events are kept this long; segments can look back at most this far. */
export const EVENT_RETENTION_DAYS = 90
/** Anonymous visitors (no email, never identified) are deleted after this long without a visit. */
export const ANONYMOUS_RETENTION_DAYS = 30

export const PAGEVIEW = '$pageview'
/** identify() calls are kept as events too, so the event stream shows when someone was identified. */
export const IDENTIFY = '$identify'

// ---------------------------------------------------------------------------------------------------------------
// Segment filters

const days = z.number().int().min(1).max(3650)
const attrKey = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_ .-]+$/, 'Attribute names use letters, numbers, spaces, _ . -')
  // Set by imports only: it names the object in the organization's bucket that the photo endpoint serves.
  .refine((k) => k !== 'photoKey', 'photoKey is set by imports')
const eventName = z.string().trim().min(1).max(100)

/**
 * Person metrics a segment can filter on (audience/metrics.ts), with their type. The app labels them
 * (apps/app/src/users/metrics.ts).
 */
export const METRICS = {
  initial_channel: 'string',
  initial_utm_source: 'string',
  initial_utm_medium: 'string',
  initial_utm_campaign: 'string',
  initial_referring_domain: 'string',
  initial_landing_page: 'string',
  last_channel: 'string',
  last_utm_source: 'string',
  last_utm_campaign: 'string',
  country: 'string',
  region: 'string',
  city: 'string',
  last_browser: 'string',
  last_os: 'string',
  last_device_type: 'string',
  last_page: 'string',
  last_event: 'string',
  sessions: 'number',
  pageviews: 'number',
  events: 'number',
  active_days: 'number',
  engaged_seconds: 'number',
  revenue_total: 'number',
  orders: 'number',
  emails_received: 'number',
  emails_sent: 'number',
  emails_replied: 'number',
  days_to_identify: 'number',
  email_bounced: 'boolean',
  email_complained: 'boolean',
} as const satisfies Record<string, 'string' | 'number' | 'boolean'>
export type MetricKey = keyof typeof METRICS

export const condition = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('date'), field: z.enum(['last_seen', 'first_seen', 'created']), op: z.enum(['within', 'not_within']), days }),
  z.object({ kind: z.literal('type'), op: z.enum(['is', 'is_not']), value: z.enum(['user', 'lead', 'contact']) }),
  z.object({
    kind: z.literal('text'),
    field: z.enum(['name', 'email', 'phone', 'source', 'domain']),
    op: z.enum(['is', 'is_not', 'contains', 'is_set', 'not_set']),
    value: z.string().max(200).default(''),
  }),
  z.object({
    kind: z.literal('attribute'),
    key: attrKey,
    op: z.enum(['is', 'is_not', 'contains', 'gt', 'lt', 'is_set', 'not_set', 'is_true', 'is_false']),
    value: z.union([z.string().max(200), z.number()]).default(''),
  }),
  z.object({
    kind: z.literal('metric'),
    key: z.enum(Object.keys(METRICS) as [MetricKey, ...MetricKey[]]),
    op: z.enum(['is', 'is_not', 'contains', 'gt', 'lt', 'is_set', 'not_set', 'is_true', 'is_false']),
    value: z.union([z.string().max(200), z.number()]).default(''),
  }),
  z.object({
    kind: z.literal('event'),
    name: eventName,
    op: z.enum(['at_least', 'did_not']),
    count: z.number().int().min(1).max(100_000).default(1),
    days: z.number().int().min(1).max(EVENT_RETENTION_DAYS),
  }),
])
export type Condition = z.output<typeof condition>

export const filter = z.object({
  match: z.enum(['all', 'any']).default('all'),
  conditions: z.array(condition).max(20).default([]),
})
export type Filter = z.output<typeof filter>

export const SEGMENT_ICONS = ['layers', 'user', 'users', 'target', 'mail', 'circle-check', 'hourglass', 'user-minus', 'clock', 'star'] as const
export type SegmentIcon = (typeof SEGMENT_ICONS)[number]

// ---------------------------------------------------------------------------------------------------------------
// People

export type Attributes = Record<string, string | number | boolean>

export type Person = {
  id: string
  /** 'contact': an address-book entry, not a website visitor (domain is ''). */
  kind: 'user' | 'lead' | 'contact'
  domain: string
  externalId: string | null
  /** The first anonymous visitor id seen for this person ("vis_…" in the dashboard). */
  anonymousId: string | null
  name: string | null
  email: string | null
  phone: string | null
  source: string
  attributes: Attributes
  firstSeenAt: string
  lastSeenAt: string
  createdAt: string
  updatedAt: string
  /**
   * Worked out by xstate from what the person did, never set by the customer: first and last touch (channel, UTM,
   * referrer, landing page), location, device, counters (sessions, pageviews, events, active_days, revenue_total…).
   * Kept apart from `attributes` so a browser can't overwrite them and they don't count toward its cap.
   */
  metrics: Attributes
  /** Contacts only: the member whose contact it is, or null when it's shared with the whole organization. */
  owner?: string | null
}

export type EventType = 'page' | 'track' | 'identify' | 'email'

export type AudienceEvent = {
  id: number
  type: EventType
  name: string
  properties: Record<string, unknown>
  url: string | null
  sessionId: string | null
  occurredAt: string
}

/** Mail between one of the organization's mailboxes and these addresses, recorded on the people who have them. */
export type EmailActivity = {
  kind: 'received' | 'replied' | 'sent' | 'bounced' | 'complained'
  addresses: string[]
  mailboxId: string
  mailbox: string
  /** The message in the mailbox, when known: makes a repeat (a retried job) a no-op. */
  emailId: string | null
  at: string
  /** Bounces and complaints: the type SES gave (Permanent, abuse…). */
  detail?: string | null
}

/** An event in the Analytics feed, with who it was. */
export type FeedEvent = AudienceEvent & {
  path: string | null
  domain: string | null
  person: { id: string; kind: 'user' | 'lead' | 'contact'; name: string | null; email: string | null; externalId: string | null; anonymousId: string | null }
}

/** The visit an event belongs to, for the event panel: only what was recorded. */
export type VisitContext = Record<string, string | number>

export type PersonDetail = { person: Person; events: AudienceEvent[]; segments: { id: string; name: string }[] }

export type Segment = { id: string; name: string; icon: SegmentIcon; filter: Filter; createdAt: string; updatedAt: string }

/** Editable fields of a person, from the dashboard or the server API. A null attribute value removes it. */
export const personFields = z.object({
  name: z.string().trim().max(200).nullable().optional(),
  email: z.string().trim().toLowerCase().email().max(254).nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  attributes: z.record(attrKey, z.union([z.string().max(500), z.number(), z.boolean(), z.null()])).optional(),
})
export type PersonFields = z.output<typeof personFields>

// ---------------------------------------------------------------------------------------------------------------
// Collected events, after collect.ts has checked the key and the user hash.

/**
 * What collect.ts learned about one event besides its name and properties: the visit it belongs to (from the
 * snippet), where the visit came from (UTM, click id, referrer; on the first page of a visit only), and the device
 * and location (from the request for browsers, from the caller's `context` for servers). Everything is optional.
 */
export type EventContext = {
  sessionId?: string
  /** The snippet started a new visit with this event. */
  sessionStart?: boolean
  path?: string
  referrer?: string
  referringDomain?: string
  campaign?: Campaign
  clickId?: ClickId
  /** Set when the event carries attribution (a visit's first page, or a server call with campaign/referrer). */
  channel?: Channel
  ip?: string
  country?: string
  region?: string
  regionCode?: string
  city?: string
  postalCode?: string
  timezone?: string
  latitude?: number
  longitude?: number
  continent?: string
  isEu?: boolean
  asn?: number
  asOrganization?: string
  browser?: string
  browserVersion?: string
  os?: string
  osVersion?: string
  deviceType?: 'desktop' | 'mobile' | 'tablet'
  screen?: string
  viewport?: string
  locale?: string
  library?: string
}

export type CollectItem = {
  /** page_leave: how long the visitor stayed on a page and how far they scrolled; updates that page view. */
  type: 'identify' | 'track' | 'page' | 'page_leave'
  domain: string
  anonymousId: string | null
  /** Only set when the call is trusted: the secret key, or a valid user hash. */
  userId: string | null
  /** Server calls may look a person up by email instead. */
  email: string | null
  traits: Record<string, unknown>
  event: string | null
  properties: Record<string, unknown>
  url: string | null
  context: EventContext
  at: string
}

export type CollectBatch = { trusted: boolean; source: string; items: CollectItem[] }
