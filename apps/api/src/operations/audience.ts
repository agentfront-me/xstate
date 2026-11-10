// Audience (the Users section): people who visit or use the organization's websites, their activity, saved segments,
// and the organization's API keys. Events come in through POST /v1/collect (audience/collect.ts), not from here.

import { z } from 'zod'
import * as audience from '../audience/service'
import { filter, personFields, SEGMENT_ICONS } from '../audience/types'
import { defineOperation } from './define'

const id = z.string().min(1).max(64)
const domain = z.string().trim().toLowerCase().min(1).max(253)
const segmentName = z.string().trim().min(1).max(60)

/** Filters arrive as JSON in a query string on GET routes. */
const filterParam = z
  .string()
  .max(8000)
  .transform((s, ctx) => {
    try {
      return filter.parse(JSON.parse(s))
    } catch {
      ctx.addIssue({ code: 'custom', message: 'filter must be a JSON segment filter' })
      return z.NEVER
    }
  })

const listInput = z.object({
  organizationId: id,
  segmentId: id.optional(),
  filter: filterParam.optional(),
  domain: domain.optional(),
  q: z.string().trim().max(200).optional(),
  // A query string: "true" lists your own auto-saved "Other contacts" (Google's) instead.
  other: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
})

export const audienceOverview = defineOperation({
  name: 'audience_overview',
  description:
    'Summary of the Users section: how many people there are, the website domains they came from (with counts), ' +
    'how many contacts and auto-saved "Other contacts" you have, and every saved segment with its filter and current member count. ' +
    'With domain, the total and segment counts cover only people on that domain or its subdomains.',
  input: z.object({ organizationId: id, domain: domain.optional() }),
  http: { method: 'GET', path: '/audience/orgs/:organizationId/overview' },
  mcp: { readOnly: true },
  run: ({ env, actor }, input) => audience.overview(env, actor, input.organizationId, input.domain),
})

export const audienceSchema = defineOperation({
  name: 'audience_schema',
  description: 'The custom attribute names (with type) and event names seen so far, for building segment filters.',
  input: z.object({ organizationId: id }),
  http: { method: 'GET', path: '/audience/orgs/:organizationId/schema' },
  mcp: { readOnly: true },
  run: ({ env, actor }, input) => audience.schema(env, actor, input.organizationId),
})

export const audienceListPeople = defineOperation({
  name: 'audience_list_people',
  description:
    'List people (users and leads, including anonymous visitors), most recently seen first. Narrow by segmentId, by ' +
    'an ad-hoc filter (JSON, same shape as a segment filter), by website domain, or by a search term (name, email, ' +
    'phone, user id or visitor id). other=true lists your own auto-saved "Other contacts" instead (addresses imported ' +
    'from Google that you emailed but never saved). Pages of up to 100; pass nextCursor back as cursor.',
  input: listInput.extend({ cursor: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }),
  http: { method: 'GET', path: '/audience/orgs/:organizationId/people' },
  mcp: { readOnly: true },
  run: ({ env, actor }, { organizationId, ...query }) => audience.listPeople(env, actor, organizationId, query),
})

export const audienceExportPeople = defineOperation({
  name: 'audience_export_people',
  description: 'Download the people a list view shows as CSV (up to 50,000 rows), custom attributes as extra columns.',
  input: listInput,
  http: { method: 'GET', path: '/audience/orgs/:organizationId/people.csv' },
  mcp: false,
  run: ({ env, actor }, { organizationId, ...query }) => audience.exportCsv(env, actor, organizationId, query),
})

export const audienceGetPerson = defineOperation({
  name: 'audience_get_person',
  description:
    "One person's profile, the segments they're in, their latest 100 events (page views and custom events), and the " +
    'latest 30 emails to or from their address in the mailboxes you can read (null if mail is unavailable).',
  input: z.object({ organizationId: id, personId: id }),
  http: { method: 'GET', path: '/audience/orgs/:organizationId/people/:personId' },
  mcp: { readOnly: true },
  run: ({ env, actor }, input) => audience.getPerson(env, actor, input.organizationId, input.personId),
})

export const audienceAddPerson = defineOperation({
  name: 'audience_add_person',
  description:
    'Add a person by hand: a lead on a website domain (email unique per domain), or a contact (kind "contact", no domain): your own, or shared with the whole organization when shared is true.',
  input: personFields.extend({
    organizationId: id,
    kind: z.enum(['lead', 'contact']).default('lead'),
    domain: domain.optional(),
    shared: z.boolean().default(false),
  }),
  http: { method: 'POST', path: '/audience/orgs/:organizationId/people', status: 201 },
  run: async ({ env, actor }, { organizationId, ...input }) => ({ person: await audience.addPerson(env, actor, organizationId, input) }),
})

export const audienceUpdatePerson = defineOperation({
  name: 'audience_update_person',
  description: "Change a person's name, email or phone, or set custom attributes (null removes one).",
  input: personFields.extend({ organizationId: id, personId: id }),
  http: { method: 'PATCH', path: '/audience/orgs/:organizationId/people/:personId' },
  run: async ({ env, actor }, { organizationId, personId, ...fields }) => ({
    person: await audience.updatePerson(env, actor, organizationId, personId, fields),
  }),
})

export const audiencePersonPhoto = defineOperation({
  name: 'audience_person_photo',
  description: "A contact's photo (imported from Google), as an image.",
  input: z.object({ organizationId: id, personId: id }),
  http: { method: 'GET', path: '/audience/orgs/:organizationId/people/:personId/photo' },
  mcp: false,
  run: ({ env, actor }, input) => audience.personPhoto(env, actor, input.organizationId, input.personId),
})

export const audienceSuggestContacts = defineOperation({
  name: 'audience_suggest_contacts',
  description: 'Contacts whose name or email contains q, for addressing mail: your own and shared contacts first, then auto-saved "Other contacts".',
  input: z.object({ organizationId: id, q: z.string().trim().min(1).max(100) }),
  http: { method: 'GET', path: '/audience/orgs/:organizationId/contacts/suggest' },
  mcp: { readOnly: true },
  run: ({ env, actor }, input) => audience.suggestContacts(env, actor, input.organizationId, input.q),
})

export const audienceDeletePeople = defineOperation({
  name: 'audience_delete_people',
  description: 'Delete people and all their events for good (for example on a data deletion request).',
  input: z.object({ organizationId: id, ids: z.array(id).min(1).max(500) }),
  http: { method: 'POST', path: '/audience/orgs/:organizationId/people/delete' },
  mcp: { destructive: true },
  run: ({ env, actor }, input) => audience.deletePeople(env, actor, input.organizationId, input.ids),
})

export const audienceCountFilter = defineOperation({
  name: 'audience_count',
  description:
    'Count how many people a segment filter matches, without saving it. A filter is { match: "all" | "any", ' +
    'conditions: [...] }; conditions are { kind: "date", field: last_seen|first_seen|created, op: within|not_within, days }, ' +
    '{ kind: "type", op: is|is_not, value: user|lead }, { kind: "text", field: name|email|phone|source|domain, ' +
    'op: is|is_not|contains|is_set|not_set, value }, { kind: "attribute", key, op: is|is_not|contains|gt|lt|is_set|' +
    'not_set|is_true|is_false, value }, or { kind: "event", name, op: at_least|did_not, count, days (max 90) }.',
  input: z.object({ organizationId: id, filter, domain: domain.optional() }),
  http: { method: 'POST', path: '/audience/orgs/:organizationId/count' },
  mcp: { readOnly: true },
  run: ({ env, actor }, input) => audience.countFilter(env, actor, input.organizationId, input.filter, input.domain),
})

export const audienceCreateSegment = defineOperation({
  name: 'audience_create_segment',
  description: 'Save a segment: a name and a filter (see audience_count for the filter shape). Membership is always live.',
  input: z.object({ organizationId: id, name: segmentName, icon: z.enum(SEGMENT_ICONS).optional(), filter }),
  http: { method: 'POST', path: '/audience/orgs/:organizationId/segments', status: 201 },
  run: async ({ env, actor }, { organizationId, ...input }) => ({ segment: await audience.saveSegment(env, actor, organizationId, input) }),
})

export const audienceUpdateSegment = defineOperation({
  name: 'audience_update_segment',
  description: "Rename a segment or replace its filter.",
  input: z.object({ organizationId: id, segmentId: id, name: segmentName, icon: z.enum(SEGMENT_ICONS).optional(), filter }),
  http: { method: 'PUT', path: '/audience/orgs/:organizationId/segments/:segmentId' },
  run: async ({ env, actor }, { organizationId, segmentId, ...input }) => ({
    segment: await audience.saveSegment(env, actor, organizationId, { id: segmentId, ...input }),
  }),
})

export const audienceDeleteSegment = defineOperation({
  name: 'audience_delete_segment',
  description: 'Delete a saved segment. The people in it are not affected.',
  input: z.object({ organizationId: id, segmentId: id }),
  http: { method: 'DELETE', path: '/audience/orgs/:organizationId/segments/:segmentId' },
  mcp: { destructive: true },
  run: ({ env, actor }, input) => audience.deleteSegment(env, actor, input.organizationId, input.segmentId),
})

// API keys: kept off MCP, so an agent can't read or replace the organization's secret key.

export const apiKeysGet = defineOperation({
  name: 'api_keys_get',
  description: "The organization's publishable key and a masked secret key. Owners and admins only.",
  input: z.object({ organizationId: id }),
  http: { method: 'GET', path: '/orgs/:organizationId/api-keys' },
  mcp: false,
  run: async ({ env, actor }, input) => ({ keys: await audience.getKeys(env, actor, input.organizationId) }),
})

export const apiKeysReveal = defineOperation({
  name: 'api_keys_reveal_secret',
  description: "The organization's secret key in full.",
  input: z.object({ organizationId: id }),
  http: { method: 'POST', path: '/orgs/:organizationId/api-keys/secret/reveal' },
  mcp: false,
  run: ({ env, actor }, input) => audience.revealSecret(env, actor, input.organizationId),
})

export const apiKeysRoll = defineOperation({
  name: 'api_keys_roll_secret',
  description: 'Replace the secret key. The old one stops working right away.',
  input: z.object({ organizationId: id }),
  http: { method: 'POST', path: '/orgs/:organizationId/api-keys/secret/roll' },
  mcp: false,
  run: ({ env, actor }, input) => audience.rollSecret(env, actor, input.organizationId),
})

export const audienceOperations = [
  audienceOverview,
  audienceSchema,
  audienceSuggestContacts,
  audiencePersonPhoto,
  audienceListPeople,
  audienceExportPeople,
  audienceGetPerson,
  audienceAddPerson,
  audienceUpdatePerson,
  audienceDeletePeople,
  audienceCountFilter,
  audienceCreateSegment,
  audienceUpdateSegment,
  audienceDeleteSegment,
  apiKeysGet,
  apiKeysReveal,
  apiKeysRoll,
]
