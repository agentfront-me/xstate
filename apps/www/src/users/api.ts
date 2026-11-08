// The audience_* API (apps/api/src/operations/audience.ts) for the Users section, and the organization's API keys.

import { api, apiBlob } from '../lib/core'
import type { MessageSummary } from '../lib/types'

export type PersonKind = 'user' | 'lead'
export type Attributes = Record<string, string | number | boolean>

export type Person = {
  id: string
  kind: PersonKind
  domain: string
  externalId: string | null
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
}

export type AudienceEvent = { id: number; name: string; properties: Record<string, unknown>; url: string | null; occurredAt: string }

export type DateField = 'last_seen' | 'first_seen' | 'created'
export type TextField = 'name' | 'email' | 'phone' | 'source' | 'domain'
export type AttrOp = 'is' | 'is_not' | 'contains' | 'gt' | 'lt' | 'is_set' | 'not_set' | 'is_true' | 'is_false'
export type Condition =
  | { kind: 'date'; field: DateField; op: 'within' | 'not_within'; days: number }
  | { kind: 'type'; op: 'is' | 'is_not'; value: PersonKind }
  | { kind: 'text'; field: TextField; op: 'is' | 'is_not' | 'contains' | 'is_set' | 'not_set'; value: string }
  | { kind: 'attribute'; key: string; op: AttrOp; value: string | number }
  | { kind: 'event'; name: string; op: 'at_least' | 'did_not'; count: number; days: number }
export type Filter = { match: 'all' | 'any'; conditions: Condition[] }

export type SegmentIcon = 'layers' | 'user' | 'users' | 'target' | 'mail' | 'circle-check' | 'hourglass' | 'user-minus' | 'clock' | 'star'
export type Segment = { id: string; name: string; icon: SegmentIcon; filter: Filter; count: number }

export type Overview = { total: number; domains: { domain: string; count: number }[]; segments: Segment[] }
export type Schema = { attributes: { key: string; type: string }[]; events: { name: string; total: number }[] }
export type PersonDetail = {
  person: Person
  events: AudienceEvent[]
  segments: { id: string; name: string }[]
  /** Mail to or from the person's email in the mailboxes you can read; null when mail couldn't be loaded. */
  emails: MessageSummary[] | null
}
export type PersonFields = { name?: string | null; email?: string | null; phone?: string | null; attributes?: Record<string, string | number | boolean | null> }

export type ListParams = { segmentId?: string; domain?: string; q?: string }

export type ApiKeys = {
  publishable: { key: string; createdAt: string }
  secret: { masked: string; createdAt: string; lastUsedAt: string | null }
}

const qs = (params: Record<string, string | number | undefined>) => {
  const s = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') s.set(k, String(v))
  const out = s.toString()
  return out ? `?${out}` : ''
}

export const audienceKeys = { all: ['audience'] as const }

export const audienceApi = {
  overview: (org: string) => api<Overview>('GET', `/audience/orgs/${org}/overview`),
  schema: (org: string) => api<Schema>('GET', `/audience/orgs/${org}/schema`),
  people: (org: string, p: ListParams & { cursor?: string }) =>
    api<{ people: Person[]; total: number; nextCursor: string | null }>('GET', `/audience/orgs/${org}/people${qs({ ...p, limit: 50 })}`),
  exportCsv: (org: string, p: ListParams) => apiBlob(`/audience/orgs/${org}/people.csv${qs(p)}`),
  person: (org: string, id: string) => api<PersonDetail>('GET', `/audience/orgs/${org}/people/${id}`),
  addPerson: (org: string, input: PersonFields & { domain: string }) => api<{ person: Person }>('POST', `/audience/orgs/${org}/people`, input),
  updatePerson: (org: string, id: string, fields: PersonFields) => api<{ person: Person }>('PATCH', `/audience/orgs/${org}/people/${id}`, fields),
  deletePeople: (org: string, ids: string[]) => api<{ deleted: number }>('POST', `/audience/orgs/${org}/people/delete`, { ids }),
  count: (org: string, filter: Filter) => api<{ count: number }>('POST', `/audience/orgs/${org}/count`, { filter }),
  createSegment: (org: string, input: { name: string; icon?: SegmentIcon; filter: Filter }) =>
    api<{ segment: Segment }>('POST', `/audience/orgs/${org}/segments`, input),
  updateSegment: (org: string, id: string, input: { name: string; icon?: SegmentIcon; filter: Filter }) =>
    api<{ segment: Segment }>('PUT', `/audience/orgs/${org}/segments/${id}`, input),
  deleteSegment: (org: string, id: string) => api('DELETE', `/audience/orgs/${org}/segments/${id}`),
}

export const keysApi = {
  get: (org: string) => api<{ keys: ApiKeys }>('GET', `/orgs/${org}/api-keys`),
  reveal: (org: string) => api<{ key: string }>('POST', `/orgs/${org}/api-keys/secret/reveal`),
  roll: (org: string) => api<{ keys: ApiKeys; key: string }>('POST', `/orgs/${org}/api-keys/secret/roll`),
}

// ---------------------------------------------------------------------------------------------------------------
// Display helpers

export const displayName = (p: Person) => p.name || p.email || (p.externalId ? `User ${p.externalId}` : 'Anonymous visitor')
export const isAnonymous = (p: Person) => !p.name && !p.email && !p.externalId
/** The short visitor id the design shows under "Anonymous visitor". */
export const shortVisitor = (p: Person) => (p.anonymousId ? p.anonymousId.slice(0, 10) : p.id.slice(0, 10))

export function relative(iso: string): string {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000)
  if (s < 60) return 'Just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`
  const days = Math.floor(s / 86_400)
  if (days === 1) return 'Yesterday'
  if (days < 7) return `${days}d ago`
  if (days < 30) return `${Math.floor(days / 7)}w ago`
  if (days < 365) return `${Math.floor(days / 30)}mo ago`
  return `${Math.floor(days / 365)}y ago`
}

export const longDate = (iso: string) => new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
export const shortDate = (iso: string) => new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' })
