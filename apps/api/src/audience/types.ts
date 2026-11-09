// Audience: the people who visit or use an organization's websites, their events, and saved segments of them.
// Shapes shared by the operations (operations/audience.ts), the public collect endpoint (collect.ts) and the
// per-organization Durable Object that stores everything (store.ts).

import { z } from 'zod'

/** Raw events are kept this long; segments can look back at most this far. */
export const EVENT_RETENTION_DAYS = 90
/** Anonymous visitors (no email, never identified) are deleted after this long without a visit. */
export const ANONYMOUS_RETENTION_DAYS = 30

export const PAGEVIEW = '$pageview'

// ---------------------------------------------------------------------------------------------------------------
// Segment filters

const days = z.number().int().min(1).max(3650)
const attrKey = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_ .-]+$/, 'Attribute names use letters, numbers, spaces, _ . -')
const eventName = z.string().trim().min(1).max(100)

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
  /** Contacts only: the member whose contact it is, or null when it's shared with the whole organization. */
  owner?: string | null
}

export type AudienceEvent = { id: number; name: string; properties: Record<string, unknown>; url: string | null; occurredAt: string }

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

export type CollectItem = {
  type: 'identify' | 'track' | 'page'
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
  at: string
}

export type CollectBatch = { trusted: boolean; source: string; items: CollectItem[] }
